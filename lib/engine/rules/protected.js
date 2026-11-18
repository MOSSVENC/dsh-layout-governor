/**
 * Rule `protected`: a protected pattern that matches nothing is the alarm.
 *
 * The workspace keeps one or two irreplaceable originals (a delisted video, a
 * master manuscript). Their patterns are listed here precisely so that
 * "nothing matched" is treated as "the original may be gone", which is the one
 * finding that must never be silently ignored.
 */

import path from 'node:path';

import { finding } from '../finding.js';
import { matchesGlob } from '../glob.js';

/** Rule id, also the policy key. */
export const id = 'protected';

/** Defaults merged under `rules.protected`. */
export const defaults = {
  enabled: true,
  severity: 'warn',
  patterns: [],
};

/**
 * Report protected patterns with zero matches on disk.
 *
 * @param {object} ctx Engine context.
 * @returns {Promise<object[]>} Findings.
 */
export async function run(ctx) {
  const config = ctx.rule(id);
  if (!config.enabled) return [];

  const patterns = Array.isArray(config.patterns) ? config.patterns : [];
  const findings = [];

  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern === '') continue;
    let matches = 0;
    for (const entry of ctx.entries) {
      if (matchesGlob(entry.rel, pattern)) matches += 1;
    }
    if (matches > 0) continue;

    findings.push(
      finding(id, {
        severity: config.severity,
        title: `Protected pattern has no matches: ${pattern}`,
        detail:
          `No path under the audit root matches "${pattern}". This pattern exists to guard an ` +
          'irreplaceable original, so zero matches means it may have been moved or deleted.',
        paths: [path.join(ctx.root, pattern)],
        suggestion: `verify the guarded original still exists, then fix "${pattern}" or drop it from rules.protected.patterns`,
        evidence: { pattern, matches: 0 },
        fixable: false,
        key: `pattern:${pattern}`,
      }),
    );
  }

  return findings;
}
