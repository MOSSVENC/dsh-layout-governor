/**
 * Rule `duplicates`: identical payloads stored more than `maxCopies` times.
 *
 * Sizes are the cheap filter, so only files that share a size with another file
 * and clear `minBytes` are ever hashed. On a 96 GB workspace that keeps the
 * audit in the hundreds of milliseconds instead of minutes.
 */

import path from 'node:path';

import { compareKeepPreference, finding } from '../finding.js';
import { matchesAny } from '../glob.js';
import { formatBytes, toCount } from '../util.js';

/** Rule id, also the policy key. */
export const id = 'duplicates';

/** Defaults merged under `rules.duplicates`. */
export const defaults = {
  enabled: true,
  severity: 'fail',
  minBytes: 104857600,
  maxCopies: 1,
  ignore: [],
};

/**
 * Report content-identical files beyond the allowed copy count.
 *
 * @param {object} ctx Engine context.
 * @returns {Promise<object[]>} Findings.
 */
export async function run(ctx) {
  const config = ctx.rule(id);
  if (!config.enabled) return [];

  const minBytes = toCount(config.minBytes, defaults.minBytes);
  const maxCopies = toCount(config.maxCopies, defaults.maxCopies);
  const ignore = Array.isArray(config.ignore) ? config.ignore : [];

  const bySize = new Map();
  for (const file of ctx.files) {
    if (file.size < minBytes) continue;
    if (matchesAny(file.rel, ignore)) continue;
    const bucket = bySize.get(file.size);
    if (bucket) bucket.push(file);
    else bySize.set(file.size, [file]);
  }

  const candidates = [];
  for (const bucket of bySize.values()) {
    if (bucket.length >= 2) candidates.push(...bucket);
  }
  if (candidates.length === 0) return [];

  // The mtime is what lets the index answer "unchanged since last run" without
  // touching the disk; without it every scan re-reads every candidate.
  const hashes = await ctx.hashAll(
    candidates.map((file) => ({ path: file.path, size: file.size, mtimeMs: file.mtimeMs })),
  );
  const mode = ctx.hashMode ?? 'full';

  const byHash = new Map();
  for (const file of candidates) {
    const digest = hashes.get(file.path);
    if (!digest) continue;
    const bucket = byHash.get(digest.sha256);
    if (bucket) bucket.push({ file, bytes: digest.bytes });
    else byHash.set(digest.sha256, [{ file, bytes: digest.bytes }]);
  }

  const findings = [];
  for (const [sha256, bucket] of byHash) {
    if (bucket.length <= maxCopies) continue;

    const ordered = bucket.map((item) => item.file).sort(compareKeepPreference);
    const keep = ordered[0];
    const removable = ordered.slice(1);
    const bytes = bucket[0].bytes;
    const reclaimableBytes = bytes * (bucket.length - 1);
    const protectedPaths = removable.filter((file) => ctx.isProtectedPath(file.rel)).map((file) => file.path);
    // A signature is strong evidence, not proof. In that mode the finding is still
    // reported — that is the whole point of a cheap scan — but nothing may be
    // deleted on the strength of 128 KiB.
    const fixable = protectedPaths.length === 0 && mode === 'full';
    const name = path.basename(keep.path);

    findings.push(
      finding(id, {
        severity: config.severity,
        title:
          mode === 'full'
            ? `${bucket.length} identical copies of ${name}`
            : `${bucket.length} copies of ${name} share a head-and-tail signature`,
        detail:
          mode === 'full'
            ? `${bucket.length} files share the same sha256 and size ${formatBytes(bytes)}`
            : `${bucket.length} files share size ${formatBytes(bytes)} and the same first and last ` +
              '64 KiB. That is strong evidence, not proof: run the CLI for a full-hash confirmation ' +
              'before removing anything.',
        paths: ordered.map((file) => file.path),
        suggestion:
          `keep ${keep.path}; remove the other ${removable.length} ` +
          `(≈${formatBytes(reclaimableBytes)})`,
        evidence: {
          sha256,
          verifiedBy: mode === 'full' ? 'sha256' : 'signature',
          bytes,
          copies: bucket.length,
          reclaimableBytes,
          keep: keep.path,
          protectedPaths,
        },
        fixable,
        key: sha256,
      }),
    );
  }

  return findings;
}
