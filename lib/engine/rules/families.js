/**
 * Rule `families`: version families that quietly grow past their budget.
 *
 * A Windows image directory is allowed two ISOs (the original and the current
 * build). The third and fourth are usually an old download and a superseded
 * rebuild that nobody removed.
 */

import path from 'node:path';

import { compareKeepPreference, finding } from '../finding.js';
import { matchesAny, matchesGlob } from '../glob.js';
import { formatBytes, toCount } from '../util.js';

/** Rule id, also the policy key. */
export const id = 'families';

/** Defaults merged under `rules.families`. */
export const defaults = {
  enabled: true,
  severity: 'warn',
  groups: [],
  // Upstream test fixtures ship several tiny ISOs on purpose; a policy exempts
  // that subtree instead of raising maxPer for the real image directories.
  ignore: [],
};

/**
 * Report directories holding more than `maxPer` files of one extension.
 *
 * @param {object} ctx Engine context.
 * @returns {Promise<object[]>} Findings.
 */
export async function run(ctx) {
  const config = ctx.rule(id);
  if (!config.enabled) return [];

  const groups = Array.isArray(config.groups) ? config.groups : [];
  const ignore = Array.isArray(config.ignore) ? config.ignore : [];
  const findings = [];

  for (const group of groups) {
    if (!group || typeof group.match !== 'string') continue;
    const maxPer = toCount(group.maxPer, 2);
    const groupBy = group.groupBy === 'extension' ? 'extension' : 'dir';

    const buckets = new Map();
    for (const file of ctx.files) {
      if (ignore.length > 0 && matchesAny(file.rel, ignore)) continue;
      if (!matchesGlob(file.rel, group.match)) continue;
      const posixDir = path.posix.dirname(file.rel);
      const dir = posixDir === '.' ? '' : posixDir;
      const key = groupBy === 'dir' ? `${dir}\u0000${file.ext}` : file.ext;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(file);
      else buckets.set(key, [file]);
    }

    for (const [key, bucket] of buckets) {
      if (bucket.length <= maxPer) continue;

      const ordered = [...bucket].sort(compareKeepPreference);
      const keep = ordered[0];
      const removable = ordered.slice(1);
      const reclaimableBytes = removable.reduce((sum, file) => sum + file.size, 0);
      const protectedPaths = removable.filter((file) => ctx.isProtectedPath(file.rel)).map((file) => file.path);
      const dir = key.split('\u0000')[0];
      const extension = keep.ext || '(no extension)';
      const where = dir === '' ? 'the workspace root' : dir;

      findings.push(
        finding(id, {
          severity: config.severity,
          title: `${bucket.length} ${extension} artifacts in ${where}`,
          detail:
            `${bucket.length} files match ${group.match} in ${where}, but at most ${maxPer} ` +
            `is allowed (groupBy: ${groupBy}).`,
          paths: ordered.map((file) => file.path),
          suggestion: `keep ${keep.path}; retire the other ${removable.length} (≈${formatBytes(reclaimableBytes)})`,
          evidence: {
            dir,
            extension,
            count: bucket.length,
            maxPer,
            groupBy,
            reclaimableBytes,
            keep: keep.path,
            protectedPaths,
          },
          fixable: protectedPaths.length === 0,
          key: `${group.match}\u0000${key}`,
        }),
      );
    }
  }

  return findings;
}
