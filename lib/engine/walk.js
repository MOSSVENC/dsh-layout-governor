/**
 * Deterministic, read-only directory traversal.
 *
 * Invariants that matter for an audit tool:
 * - directory symlinks are never followed (no loops, no escaping the root),
 * - ignored subtrees are skipped before they can inflate stats,
 * - `maxDepth` / `maxEntries` set `truncated` instead of throwing,
 * - entries come back sorted by relative path so two runs are comparable.
 *
 * The traversal is breadth-first over batches of directories and resolves every
 * non-directory entry through one bounded `lstat` pool. On a DrvFs mount a single
 * stat is a round-trip; measured over 3000 entries on WSL, 8 in flight is ~14x
 * faster than one at a time, while 32 adds nothing. Serial traversal of a
 * 100k-file tree takes minutes and looks like a hang, which is why the pool is
 * not an optimisation but a requirement.
 */

import { readdir, lstat, readlink } from 'node:fs/promises';
import path from 'node:path';

import { matchesAny } from './glob.js';
import { checkAborted, toPosix } from './util.js';

const DEFAULT_MAX_ENTRIES = 200000;
const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_CONCURRENCY = 16;

/**
 * Sort two dirents by name.
 * @param {{ name: string }} a
 * @param {{ name: string }} b
 * @returns {number}
 */
function byName(a, b) {
  return a.name === b.name ? 0 : a.name < b.name ? -1 : 1;
}

/**
 * Walk a tree without following symlinked directories.
 *
 * @param {object} options
 * @param {string} options.root Absolute audit root.
 * @param {readonly string[]} [options.ignore] Glob patterns relative to the root.
 * @param {number} [options.maxDepth] Deepest directory level that is descended into.
 * @param {number} [options.maxEntries] Hard cap on recorded entries.
 * @param {number} [options.concurrency] Filesystem operations in flight.
 * @param {ReadonlySet<string>} [options.skipPaths] Absolute paths never recorded (audit metadata).
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ entries: object[], truncated: boolean, stats: object }>}
 */
export async function walkTree(options) {
  const root = options.root;
  const ignore = options.ignore ?? [];
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : DEFAULT_MAX_DEPTH;
  const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : DEFAULT_MAX_ENTRIES;
  const concurrency =
    Number.isFinite(options.concurrency) && options.concurrency > 0
      ? Math.max(1, Math.floor(options.concurrency))
      : DEFAULT_CONCURRENCY;
  const skipPaths = options.skipPaths ?? new Set();
  const signal = options.signal;

  const entries = [];
  let truncated = false;
  // A permission error or a vanished file must not be silent: a tree that cannot
  // be fully read is not the same as a compliant tree, and the caller needs to
  // know the audit was partial.
  let unreadable = 0;
  let symlinks = 0;
  let files = 0;
  let directories = 0;
  let bytes = 0;

  let frontier = [{ dir: root, depth: 0 }];

  while (frontier.length > 0) {
    checkAborted(signal);
    if (entries.length >= maxEntries) {
      truncated = true;
      break;
    }
    const batch = frontier;
    frontier = [];

    // 1) list every directory of this batch, bounded.
    const listings = [];
    for (let at = 0; at < batch.length; at += concurrency) {
      const slice = batch.slice(at, at + concurrency);
      const listed = await Promise.all(
        slice.map(async (frame) => {
          try {
            return { frame, dirents: await readdir(frame.dir, { withFileTypes: true }) };
          } catch {
            return { frame, dirents: null };
          }
        }),
      );
      for (const item of listed) {
        if (item.dirents === null) unreadable += 1;
        else listings.push(item);
      }
    }
    checkAborted(signal);

    // 2) classify: a plain directory needs no stat, everything else does.
    const records = [];
    const needsStat = [];
    for (const { frame, dirents } of listings) {
      dirents.sort(byName);
      for (const dirent of dirents) {
        const abs = path.join(frame.dir, dirent.name);
        if (skipPaths.has(abs)) continue;
        const rel = toPosix(path.relative(root, abs));
        if (matchesAny(rel, ignore)) continue;
        const record = { frame, dirent, abs, rel, depth: frame.depth + 1, st: null, missing: false };
        records.push(record);
        if (!(dirent.isDirectory() && !dirent.isSymbolicLink())) needsStat.push(record);
      }
    }

    // 3) one bounded stat pool for the whole batch.
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, needsStat.length) }, async () => {
      while (cursor < needsStat.length) {
        const record = needsStat[cursor];
        cursor += 1;
        try {
          record.st = await lstat(record.abs);
        } catch {
          record.missing = true;
          unreadable += 1;
        }
        if (cursor % 512 === 0) checkAborted(signal);
      }
    });
    await Promise.all(workers);
    checkAborted(signal);

    // 4) resolve symlink targets through the same bounded pattern.
    const links = records.filter((record) => record.st !== null && record.st.isSymbolicLink());
    let linkCursor = 0;
    const linkWorkers = Array.from({ length: Math.min(concurrency, links.length) }, async () => {
      while (linkCursor < links.length) {
        const record = links[linkCursor];
        linkCursor += 1;
        record.linkTarget = null;
        record.linkTargetAbs = null;
        try {
          record.linkTarget = await readlink(record.abs);
          record.linkTargetAbs = path.resolve(record.frame.dir, record.linkTarget);
        } catch {
          // A link that cannot be read is still a link; it is reported as dead.
        }
        try {
          const target = await lstat(record.linkTargetAbs ?? record.abs);
          record.linkDead = false;
          record.linkTargetIsDirectory = target.isDirectory();
        } catch {
          record.linkDead = true;
          record.linkTargetIsDirectory = false;
        }
      }
    });
    await Promise.all(linkWorkers);

    // 5) materialise entries, honouring the entry cap without dropping the batch.
    const room = maxEntries - entries.length;
    if (records.length > room) {
      records.length = Math.max(0, room);
      truncated = true;
    }

    for (const record of records) {
      if (record.missing) continue;
      const st = record.st;
      const isSymlink = st ? st.isSymbolicLink() : false;
      const isDirectory = st ? st.isDirectory() : true;
      const isFile = st ? st.isFile() : false;

      const entry = {
        path: record.abs,
        rel: record.rel,
        name: record.dirent.name,
        depth: record.depth,
        isFile,
        isDirectory,
        isSymlink,
        size: isFile ? st.size : 0,
        mtimeMs: st ? st.mtimeMs : 0,
        ext: isFile ? path.extname(record.dirent.name).toLowerCase() : '',
      };

      if (isSymlink) {
        entry.linkTarget = record.linkTarget ?? null;
        entry.linkTargetAbs = record.linkTargetAbs ?? null;
        entry.linkDead = record.linkDead === true;
        entry.linkTargetIsDirectory = record.linkTargetIsDirectory === true;
        symlinks += 1;
      }

      entries.push(entry);
      if (isFile) {
        files += 1;
        bytes += st.size;
      } else if (isDirectory) {
        directories += 1;
      }

      if (!isDirectory) continue;
      if (record.depth >= maxDepth) {
        record.deepDirectory = true;
        continue;
      }
      frontier.push({ dir: record.abs, depth: record.depth });
    }

    if (truncated) break;

    // 6) a depth cut is only worth reporting when the cut directory was not empty.
    const deep = records.filter((record) => record.deepDirectory === true);
    if (deep.length > 0) {
      let deepCursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(concurrency, deep.length) }, async () => {
          while (deepCursor < deep.length) {
            const record = deep[deepCursor];
            deepCursor += 1;
            if (await hasVisibleChildren(record.abs, root, ignore)) truncated = true;
          }
        }),
      );
    }
  }

  entries.sort((a, b) => (a.rel === b.rel ? 0 : a.rel < b.rel ? -1 : 1));

  return {
    entries,
    truncated,
    stats: { entries: entries.length, files, directories, symlinks, bytes, unreadable },
  };
}

/**
 * True when a directory holds at least one entry the walk would have recorded.
 * @param {string} dir Absolute directory.
 * @param {string} root Absolute audit root.
 * @param {readonly string[]} ignore Glob patterns.
 * @returns {Promise<boolean>}
 */
async function hasVisibleChildren(dir, root, ignore) {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const dirent of dirents) {
    const abs = path.join(dir, dirent.name);
    if (matchesAny(toPosix(path.relative(root, abs)), ignore)) continue;
    return true;
  }
  return false;
}
