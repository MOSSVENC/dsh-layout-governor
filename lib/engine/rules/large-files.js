/**
 * Rule `large-files`: anything above `minBytes` must be declared in the
 * registry, so a 29 GB virtual disk can be accounted for before it becomes a
 * surprise during a disk-full incident.
 *
 * Regenerable paths are exempt on purpose: a 14 GB `.venv` is rebuilt with one
 * command, and demanding a per-file registration for it would only produce
 * noise. The composition panel still shows its size.
 *
 * `stale` findings are the mirror image: an entry whose path is gone. A stale
 * glob is reported as `warn` rather than the rule severity because a glob that
 * currently matches nothing is a much weaker signal than a vanished exact file.
 */

import { finding } from '../finding.js';
import { isGlobPattern, matchesGlob } from '../glob.js';
import { formatBytes, trimSlashes } from '../util.js';

/** Rule id, also the policy key. */
export const id = 'large-files';

/** Defaults merged under `rules['large-files']`. */
export const defaults = {
  enabled: true,
  severity: 'fail',
  minBytes: 1073741824,
  registry: 'layout.registry.yml',
};

/**
 * Report large files missing from the registry, and registry entries with no file.
 *
 * @param {object} ctx Engine context.
 * @returns {Promise<object[]>} Findings.
 */
export async function run(ctx) {
  const config = ctx.rule(id);
  if (!config.enabled) return [];

  const minBytes = Number.isFinite(Number(config.minBytes)) ? Number(config.minBytes) : defaults.minBytes;
  const entries = ctx.registry.entries ?? [];
  const findings = [];

  for (const file of ctx.files) {
    if (file.size < minBytes) continue;
    if (ctx.isRegenerable(file.rel)) continue;
    if (matchesRegistry(entries, file.rel)) continue;

    const protectedPaths = ctx.isProtectedPath(file.rel) ? [file.path] : [];
    findings.push(
      finding(id, {
        severity: config.severity,
        title: `Unregistered large file: ${file.rel} (${formatBytes(file.size)})`,
        detail:
          `${file.rel} is ${formatBytes(file.size)} (threshold ${formatBytes(minBytes)}) but has no ` +
          'entry in the registry, so its purpose, owner and relocatability are unknown.',
        paths: [file.path],
        suggestion: `register ${file.rel} in ${config.registry} with purpose, bytes and externalizable`,
        evidence: { bytes: file.size, threshold: minBytes, protectedPaths },
        fixable: true,
        key: `unregistered:${file.rel}`,
      }),
    );
  }

  const seen = new Set();
  for (const entry of entries) {
    const rel = trimSlashes(entry.path);
    if (rel === '') continue;
    const glob = isGlobPattern(rel);
    const hit = glob
      ? ctx.entries.some((candidate) => candidate.rel === rel || matchesGlob(candidate.rel, rel))
      : ctx.byRel.has(rel);
    if (hit) continue;
    if (seen.has(rel)) continue;
    seen.add(rel);

    findings.push(
      finding(id, {
        severity: glob ? 'warn' : config.severity,
        title: `Stale registry entry: ${rel}`,
        detail: glob
          ? `Registry pattern "${rel}" matches nothing on disk.`
          : `Registry entry "${rel}" points at a path that no longer exists.`,
        paths: [],
        suggestion: `remove the "${rel}" entry from ${config.registry} or restore the file`,
        evidence: { registryPath: rel, glob, declaredBytes: entry.bytes },
        fixable: false,
        key: `stale:${rel}`,
      }),
    );
  }

  return findings;
}

function matchesRegistry(entries, rel) {
  for (const entry of entries) {
    const pattern = trimSlashes(entry.path);
    if (pattern === '') continue;
    if (pattern === rel) return true;
    if (isGlobPattern(pattern) && matchesGlob(rel, pattern)) return true;
  }
  return false;
}
