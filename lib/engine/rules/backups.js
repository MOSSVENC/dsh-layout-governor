/**
 * Rule `backups`: all backups live in `_archive/YYYYMMDD_<source>/` and nowhere
 * else. A backup directory scattered inside a domain tree is the classic way a
 * workspace doubles in size overnight.
 *
 * Legacy symlinks are handled separately: after a migration the old path is kept
 * as a pointer into `_archive/`, which is legitimate but temporary.
 */

import path from 'node:path';

import { finding } from '../finding.js';
import { matchesAny, matchesAnyName } from '../glob.js';
import { trimSlashes } from '../util.js';

/** Rule id, also the policy key. */
export const id = 'backups';

/** Defaults merged under `rules.backups`. */
export const defaults = {
  enabled: true,
  severity: 'fail',
  allowedRoots: ['_archive'],
  allowedNamePattern: '^[0-9]{8}_[a-z0-9_-]+$',
  forbidNames: ['_backup', '_rescue_*', '*.bak.*', '*.bak', 'backup_*'],
  legacySymlinks: 'warn',
  // Vendored third-party trees carry names like `backup_rules.xml` that have
  // nothing to do with our backup discipline; a policy exempts them here rather
  // than weakening the pattern for everybody.
  ignore: [],
};

/**
 * Report misplaced backups and badly named archive entries.
 *
 * @param {object} ctx Engine context.
 * @returns {Promise<object[]>} Findings.
 */
export async function run(ctx) {
  const config = ctx.rule(id);
  if (!config.enabled) return [];

  const allowedRoots = (Array.isArray(config.allowedRoots) ? config.allowedRoots : [])
    .map((root) => trimSlashes(String(root)))
    .filter(Boolean);
  const forbidNames = Array.isArray(config.forbidNames) ? config.forbidNames : [];
  const namePattern = compileNamePattern(config.allowedNamePattern);
  const legacyMode = String(config.legacySymlinks ?? 'warn').toLowerCase();
  const ignore = Array.isArray(config.ignore) ? config.ignore : [];

  const findings = [];
  // One finding per misplaced backup root: reporting every descendant of
  // `writings/_backup/` would just repeat the same mistake N times.
  const reported = new Set();

  for (const entry of ctx.entries) {
    if (ignore.length > 0 && matchesAny(entry.rel, ignore)) continue;
    const segments = entry.rel.split('/');
    const top = segments[0];

    if (allowedRoots.includes(top)) {
      // Only the first level under the archive root is a naming decision.
      if (segments.length === 2 && namePattern && !namePattern.test(segments[1])) {
        findings.push(
          finding(id, {
            severity: config.severity,
            title: `Archive entry not named YYYYMMDD_<source>: ${segments[1]}`,
            detail:
              `"${entry.rel}" lives in the archive root but does not match ` +
              `allowedNamePattern ${config.allowedNamePattern}.`,
            paths: [entry.path],
            suggestion: `rename to <YYYYMMDD>_<source>, e.g. ${suggestArchiveName(segments[1], entry.mtimeMs)}`,
            evidence: { pattern: config.allowedNamePattern, name: segments[1] },
            fixable: false,
            key: `archive-name:${entry.rel}`,
          }),
        );
      }
      continue;
    }

    const hit = firstMatchingSegment(segments, forbidNames);
    if (!hit) continue;
    if (!isBackupEntry(entry, forbidNames)) continue;

    const pointsIntoArchive =
      entry.isSymlink && entry.linkTargetAbs
        ? allowedRoots.some((root) => isInside(path.join(ctx.root, root), entry.linkTargetAbs))
        : false;

    if (pointsIntoArchive && legacyMode === 'allow') continue;

    if (pointsIntoArchive) {
      const severity = legacyMode === 'fail' ? 'fail' : 'warn';
      findings.push(
        finding(id, {
          severity,
          title: `Legacy backup symlink outside ${allowedRoots.join('/')}: ${entry.name}`,
          detail:
            `"${entry.rel}" points into ${allowedRoots.join('/')} (${entry.linkTarget || 'unknown'}), ` +
            'so it is a legitimate old pointer, but the old path should not survive forever.',
          paths: [entry.path],
          suggestion: `keep ${entry.name} for the migration window, then remove the symlink and use the archive path`,
          evidence: { name: entry.name, matched: hit, linkTarget: entry.linkTarget, legacySymlink: true },
          fixable: false,
          key: `legacy-symlink:${entry.rel}`,
        }),
      );
      continue;
    }

    if (hasReportedAncestor(entry.rel, reported)) continue;
    reported.add(entry.rel);

    // A backup *directory* may contain an irreplaceable file. Moving the directory
    // moves the keeper, which is exactly what "protected" forbids — so the subtree
    // is checked, not just the flagged path.
    const protectedPaths = protectDescendants(ctx, entry);
    findings.push(
      finding(id, {
        severity: config.severity,
        title: `Backup outside ${allowedRoots.join('/')}: ${entry.rel}`,
        detail:
          `Path segment "${hit}" marks a backup, but the entry is not under ` +
          `${allowedRoots.join('/')}, which is the only declared home for backups.`,
        paths: [entry.path],
        suggestion: `move ${entry.path} to ${allowedRoots[0] || '_archive'}/<YYYYMMDD>_<source>/`,
        evidence: { matched: hit, name: entry.name, kind: entry.isDirectory ? 'directory' : 'file', protectedPaths },
        fixable: protectedPaths.length === 0,
        key: `misplaced:${entry.rel}`,
      }),
    );
  }

  return findings;
}

/**
 * Every protected path at or below one entry.
 *
 * The `protected` rule reports the keeper it found; this answers the inverse
 * question for a directory that is about to be moved: does anything irreplaceable
 * live underneath it?
 *
 * @param {object} ctx Engine context.
 * @param {object} entry Walk entry that may be moved.
 * @returns {string[]} Absolute paths that must not move.
 */
function protectDescendants(ctx, entry) {
  if (ctx.isProtectedPath(entry.rel)) return [entry.path];
  if (entry.isDirectory !== true) return [];
  const prefix = `${entry.rel}/`;
  const guarded = [];
  for (const candidate of ctx.entries) {
    if (!candidate.rel.startsWith(prefix)) continue;
    if (ctx.isProtectedPath(candidate.rel)) guarded.push(candidate.path);
  }
  return guarded;
}

function compileNamePattern(pattern) {
  if (typeof pattern !== 'string' || pattern === '') return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * Name patterns that describe a *copy artifact* rather than a directory of them.
 *
 * `backup_*` names a kind of directory. A file called `backup_panel_db.sh` is a
 * maintenance script that performs backups, not a backup — and a governor that
 * files it into the archive is a governor that breaks a workspace.
 */
const ARTIFACT_SUFFIXES = ['*.bak', '*.bak.*', '*~', '*.orig', '*.old', '*.save', '*.backup'];
const ARCHIVE_EXTENSION = /\.(tar|tar\.gz|tgz|gz|xz|bz2|zip|7z|rar|sql|dump|bak|orig|old|save)$/i;

/**
 * Whether a matched entry really is a backup.
 *
 * Directories are decided by name alone. Files must look like a copy: a
 * copy-artifact suffix, or an archive/dump extension.
 *
 * @param {object} entry Walk entry.
 * @param {string[]} patterns Configured `forbidNames`.
 * @returns {boolean}
 */
function isBackupEntry(entry, patterns) {
  // A symlink is a pointer, and a pointer named `_backup` is exactly the legacy
  // case this rule exists to report. Requiring a file-ish extension from a
  // symlink hid every legacy link in the workspace.
  if (entry.isSymlink === true) return true;
  if (entry.isDirectory === true) return true;
  if (matchesAnyName(entry.name, ARTIFACT_SUFFIXES)) return true;
  if (ARCHIVE_EXTENSION.test(entry.name)) return true;
  return patterns.some((pattern) => pattern.includes('.') && matchesAnyName(entry.name, [pattern]));
}

function firstMatchingSegment(segments, patterns) {
  for (const segment of segments) {
    if (matchesAnyName(segment, patterns)) return segment;
  }
  return null;
}

function isInside(parent, child) {
  const normalizedParent = path.resolve(parent);
  const normalizedChild = path.resolve(child);
  if (normalizedChild === normalizedParent) return true;
  return normalizedChild.startsWith(normalizedParent + path.sep);
}

function hasReportedAncestor(rel, reported) {
  const segments = rel.split('/');
  let prefix = '';
  for (let i = 0; i < segments.length - 1; i += 1) {
    prefix = prefix === '' ? segments[i] : `${prefix}/${segments[i]}`;
    if (reported.has(prefix)) return true;
  }
  return false;
}

// Derived from the entry's own mtime instead of wall clock time so that two
// audits of the same tree produce byte-identical suggestions.
function suggestArchiveName(name, mtimeMs) {
  // Directories carry no mtime (see walk.js), so fall back to a literal
  // placeholder instead of inventing a 1970 date.
  const usable = Number.isFinite(mtimeMs) && mtimeMs > 0;
  const stamp = usable ? new Date(mtimeMs).toISOString().slice(0, 10).replace(/-/g, '') : 'YYYYMMDD';
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return `${stamp}_${slug || 'source'}`;
}
