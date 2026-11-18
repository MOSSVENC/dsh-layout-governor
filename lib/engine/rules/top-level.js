/**
 * Rule `top-level`: the root may only contain the directories the workspace
 * declares. Everything else is either a new line of business that must be
 * declared, or leftover junk.
 */

import { finding } from '../finding.js';
import { matchesAnyName } from '../glob.js';

/** Rule id, also the policy key. */
export const id = 'top-level';

/** Defaults merged under `rules['top-level']`. */
export const defaults = {
  enabled: true,
  severity: 'fail',
  allow: [],
  allowPatterns: [],
  ignore: [],
};

/**
 * Report root-level entries that are neither allow-listed nor ignored.
 *
 * @param {object} ctx Engine context.
 * @returns {Promise<object[]>} Findings.
 */
export async function run(ctx) {
  const config = ctx.rule(id);
  if (!config.enabled) return [];

  const allow = new Set(Array.isArray(config.allow) ? config.allow : []);
  const allowPatterns = Array.isArray(config.allowPatterns) ? config.allowPatterns : [];
  const ignore = Array.isArray(config.ignore) ? config.ignore : [];
  const findings = [];

  for (const entry of ctx.topLevel) {
    const name = entry.name;
    if (matchesAnyName(name, ignore)) continue;
    if (allow.has(name)) continue;
    if (matchesAnyName(name, allowPatterns)) continue;

    const protectedPaths = ctx.isProtectedPath(entry.rel) ? [entry.path] : [];
    const kind = entry.isSymlink ? 'symlink' : entry.isDirectory ? 'directory' : 'file';
    findings.push(
      finding(id, {
        severity: config.severity,
        title: `Unexpected top-level ${kind}: ${name}`,
        detail:
          `${kind} "${name}" is not listed in rules['top-level'].allow and matches no ` +
          'allowPatterns entry, so it is outside the declared workspace layout.',
        paths: [entry.path],
        suggestion: `move ${entry.path} into a declared directory, or add "${name}" to rules['top-level'].allow`,
        evidence: { name, kind, protectedPaths },
        fixable: protectedPaths.length === 0,
        key: `${name}:${kind}`,
      }),
    );
  }

  return findings;
}
