/**
 * Finding construction.
 *
 * Every rule funnels through here so ids stay stable, paths stay sorted and no
 * rule can accidentally emit a finding without a severity.
 */

import { findingId } from './util.js';

/**
 * Build one finding object ready to be appended to the report.
 *
 * `key` is the stable identity (paths, hash, glob). It is hashed into the id, so
 * re-running the audit on the same tree yields the same ids.
 *
 * @param {string} rule Rule id.
 * @param {object} spec Finding payload.
 * @param {string} spec.severity One of `fail`, `warn`, `info`.
 * @param {string} spec.title Short one-line summary.
 * @param {string} spec.detail Longer explanation.
 * @param {string[]} [spec.paths] Absolute paths, sorted by this helper.
 * @param {string} [spec.suggestion] What a human should do.
 * @param {object} [spec.evidence] Machine-readable numbers.
 * @param {boolean} [spec.fixable] Whether the fix plan may act automatically.
 * @param {string} [spec.key] Stable identity; defaults to title + paths.
 * @returns {object} Finding.
 */
export function finding(rule, spec) {
  const paths = [...new Set(spec.paths ?? [])].sort();
  const key = spec.key ?? `${spec.title}\n${paths.join('\n')}`;
  return {
    id: findingId(rule, key),
    rule,
    severity: spec.severity,
    title: spec.title,
    detail: spec.detail,
    paths,
    suggestion: spec.suggestion ?? '',
    evidence: spec.evidence ?? {},
    fixable: spec.fixable === true,
  };
}

/**
 * Pick the copy to keep: newest mtime first, then shortest path, then lexical.
 *
 * @param {object} a Entry with `mtimeMs` and `rel`.
 * @param {object} b Entry with `mtimeMs` and `rel`.
 * @returns {number}
 */
export function compareKeepPreference(a, b) {
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
  if (a.rel.length !== b.rel.length) return a.rel.length - b.rel.length;
  return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
}
