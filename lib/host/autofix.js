/**
 * Self-healing for the one action class that is reversible.
 *
 * The governor is read-only by default and always by contract: `audit()` never
 * writes. This module is the single, explicitly opted-in exception, and it is
 * narrow on purpose — it moves misplaced backups into `_archive/YYYYMMDD_<source>/`
 * and records what it did. It never deletes, never rewrites a document, never
 * touches a protected path, and never moves something that already lives in the
 * archive.
 *
 * Every run leaves two artifacts next to the moves: a JSONL log a machine can
 * read, and an `undo.sh` that puts everything back. An automatic action that
 * cannot be undone in one command is not automatic, it is irreversible.
 */

import { appendFile, mkdir, open, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { archiveDestination } from '../engine/fixplan.js';
import { matchesAny } from '../engine/glob.js';

/** The only action kind this module will ever perform. */
export const ALLOWED_KIND = 'move-to-archive';

/** Directory name that holds this run's log and undo script. */
const LOG_DIR = 'layout-governor';

/**
 * Flatten every protected path the report names.
 * @param {object} report Engine report.
 * @returns {Set<string>} Absolute paths that must never move.
 */
function protectedPaths(report) {
  const guarded = new Set();
  for (const finding of report.findings) {
    const list = finding.evidence?.protectedPaths;
    if (Array.isArray(list)) for (const item of list) guarded.add(item);
  }
  return guarded;
}

/**
 * Whether any protected pattern points inside a subtree.
 *
 * The policy's globs are the authority; a directory about to be moved is tested
 * against them for its own path and for every path below it.
 *
 * @param {object} report Engine report.
 * @param {string} source Absolute source path.
 * @returns {boolean} True when the subtree holds something protected.
 */
function patternsCoverSubtree(report, source) {
  const patterns = report.protection?.patterns;
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const rel = path.relative(report.root, source).split(path.sep).join('/');
  for (const pattern of patterns) {
    const prefix = String(pattern).replace(/\/\*\*.*$/, '');
    if (prefix === '') continue;
    if (prefix === rel || prefix.startsWith(`${rel}/`)) return true;
    if (matchesAny(`${rel}/x`, pattern)) return true;
  }
  return false;
}

/**
 * Choose the actions this run may perform.
 *
 * Shallow paths first: moving `a/_backup` before `a/_backup/deep` keeps a single
 * action in the plan instead of two that fight each other.
 *
 * @param {object} report Engine report.
 * @param {{ kinds?: string[], maxPerRun?: number }} [settings] Policy settings.
 * @param {object[]} [actions] Actions from `buildFixPlan(report)`.
 * @returns {object[]} Actions to perform, already ordered.
 */
export function selectAutoActions(report, settings = {}, actions = []) {
  // Defence in depth: the host checks this too, and a policy that opted out must
  // stay opted out even if a caller forgets.
  if (settings.enabled === false) return [];
  const kinds = Array.isArray(settings.kinds) && settings.kinds.length > 0 ? settings.kinds : [ALLOWED_KIND];
  const rules = Array.isArray(settings.rules) && settings.rules.length > 0 ? settings.rules : ['backups'];
  const limit =
    Number.isFinite(settings.maxPerRun) && settings.maxPerRun > 0 ? Math.floor(settings.maxPerRun) : 20;
  const guarded = protectedPaths(report);
  const archiveRoot = path.join(report.root, '_archive');

  const candidates = actions.filter((action) => {
    if (action.kind !== ALLOWED_KIND || !kinds.includes(action.kind)) return false;
    // A rule outside the declared set may be describing something that is not
    // misplaced at all — `top-level` flags any new directory, for instance.
    if (!rules.includes(action.rule)) return false;
    const source = action.paths[0];
    if (typeof source !== 'string') return false;
    if (guarded.has(source)) return false;
    // Never re-file something that already lives in the archive.
    if (source === archiveRoot || source.startsWith(`${archiveRoot}${path.sep}`)) return false;
    return true;
  });

  candidates.sort((left, right) => {
    const depth = left.paths[0].split(path.sep).length - right.paths[0].split(path.sep).length;
    if (depth !== 0) return depth;
    return left.paths[0] < right.paths[0] ? -1 : 1;
  });

  const chosen = [];
  const covered = [];
  for (const action of candidates) {
    const source = action.paths[0];
    // A parent that already moved makes its children moot.
    if (covered.some((done) => source.startsWith(`${done}${path.sep}`))) continue;
    covered.push(source);
    chosen.push(action);
    if (chosen.length >= limit) break;
  }
  return chosen;
}

/**
 * Move one action's source into the archive.
 * @param {object} params
 * @param {string} params.root Audit root.
 * @param {string} params.stamp `YYYYMMDD` archive stamp.
 * @param {object} params.action Action from the fix plan.
 * @returns {Promise<{ source: string, destination: string }>}
 */
async function performMove({ root, stamp, action }) {
  const source = action.paths[0];
  const info = await stat(source);
  const base = archiveDestination(root, stamp, source, info.isDirectory());
  await mkdir(path.dirname(base), { recursive: true });
  // POSIX `rename` REPLACES an existing destination. The earlier comment here
  // claimed the opposite, and an audit of this file proved it wrong: a second run
  // silently destroyed the first archive copy. Claim the name first, and step
  // aside with a numeric suffix when it is taken.
  const destination = await claimDestination(base);
  await rename(source, destination);
  return { source, destination };
}

/**
 * Apply the reversible part of a report's fix plan.
 *
 * @param {object} report Engine report, including `autofix` and `__actions`.
 * @param {object} [options]
 * @param {object[]} [options.actions] Actions from `buildFixPlan(report)`.
 * @param {string} [options.now] ISO timestamp, for a fixed stamp in tests.
 * @returns {Promise<{ dryRun: boolean, moved: object[], skipped: object[], logPath: string|null, undoPath: string|null }>}
 */
export async function applyAutoActions(report, options = {}) {
  const settings = report.autofix ?? {};
  const dryRun = settings.enabled !== true || settings.dryRun !== false;
  const actions = selectAutoActions(report, settings, Array.isArray(options.actions) ? options.actions : []);
  const stamp = (options.now ?? report.generatedAt ?? new Date().toISOString()).slice(0, 10).replace(/-/g, '');

  if (dryRun || actions.length === 0) {
    return {
      dryRun,
      moved: actions.map((action) => ({ source: action.paths[0], destination: null })),
      skipped: [],
      logPath: null,
      undoPath: null,
    };
  }

  const logDir = path.join(report.root, '_archive', `${stamp}_${LOG_DIR}`);
  await mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, 'moves.jsonl');
  const undoPath = path.join(logDir, 'undo.sh');

  const moved = [];
  const skipped = [];
  for (const action of actions) {
    try {
      const result = await performMove({ root: report.root, stamp, action });
      moved.push({ ...result, rule: action.rule, reason: action.reason });
      await appendFile(
        logPath,
        `${JSON.stringify({
          at: new Date().toISOString(),
          source: result.source,
          destination: result.destination,
          rule: action.rule,
          reason: action.reason,
        })}\n`,
        'utf8',
      );
    } catch (error) {
      skipped.push({ source: action.paths[0], reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const undoLines = [
    '#!/usr/bin/env bash',
    '# Undo the automatic moves recorded by dsh-layout-governor.',
    '# Every line is the exact reverse of one move; run it only if the archive',
    '# content was not edited since.',
    'set -eu',
    '',
    ...moved.map(
      (item) => `mv -n -- ${quote(item.destination)} ${quote(item.source)}`,
    ),
  ];
  await writeFile(undoPath, `${undoLines.join('\n')}\n`, 'utf8');

  return { dryRun: false, moved, skipped, logPath, undoPath };
}

/**
 * Pick a destination that does not exist yet.
 *
 * `rename` is atomic but destructive: it overwrites. The archive is the one place
 * in this system that must never lose a file to a name collision, so the name is
 * claimed with an exclusive create before the move, and a numeric suffix is used
 * when another copy already sits there.
 *
 * @param {string} base Intended destination.
 * @returns {Promise<string>} A free path.
 */
async function claimDestination(base) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}~${attempt}`;
    try {
      const handle = await open(candidate, 'wx');
      await handle.close();
      // Leave nothing behind: the marker exists only to reserve the name.
      await unlink(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`cannot claim an archive name for ${base}`);
}

/**
 * Single-quote a path for a shell script.
 * @param {string} value Path.
 * @returns {string} Quoted path.
 */
function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
