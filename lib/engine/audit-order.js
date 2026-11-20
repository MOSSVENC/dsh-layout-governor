/**
 * The small decisions an audit makes around its walk: how wide to walk, where the
 * registry lives, and how findings are ordered.
 *
 * They live here rather than in the audit itself so the audit reads as one job —
 * walk, judge, report — instead of walk, judge, report, plus three helpers nobody
 * reading the report needs.
 */

import path from 'node:path';

import * as largeFiles from './rules/large-files.js';

/** Severity order, so two runs produce the same list. */
const SEVERITY_RANK = { fail: 0, warn: 1, info: 2 };

/**
 * Traversal width, honouring the dedicated knob and falling back to the hash knob
 * that older hosts already set.
 *
 * @param {object} limits Audit limits.
 * @param {number} fallback Width when neither knob is set.
 * @returns {number}
 */
export function resolveWalkConcurrency(limits, fallback) {
  const walk = Number(limits.walkConcurrency);
  if (Number.isFinite(walk) && walk > 0) return Math.floor(walk);
  const hash = Number(limits.hashConcurrency);
  if (Number.isFinite(hash) && hash > 0) return Math.floor(hash);
  return fallback;
}

/**
 * The registry lives beside the policy: a policy inherited from an ancestor must
 * bring its own registry, not look for one at the subtree root.
 *
 * @param {string} policyPath Absolute policy path.
 * @param {object} options Audit options.
 * @param {Map<string, object>} configs Resolved rule configs.
 * @returns {string} Absolute registry path.
 */
export function resolveRegistryPath(policyPath, options, configs) {
  if (options.registryPath) return path.resolve(options.registryPath);
  const policyDir = path.dirname(policyPath);
  const config = configs.get(largeFiles.id);
  const declared = config && typeof config.registry === 'string' ? config.registry.trim() : '';
  if (declared !== '') return path.resolve(policyDir, declared);
  return path.join(policyDir, 'layout.registry.yml');
}

/**
 * Sort findings by severity, then rule, then id.
 *
 * @param {object} a Finding.
 * @param {object} b Finding.
 * @returns {number}
 */
export function compareFindings(a, b) {
  const rank = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
  if (rank !== 0) return rank;
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}
