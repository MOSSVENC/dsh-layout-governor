/**
 * dsh-layout-governor — audit engine.
 *
 * Public surface (the host half codes against exactly this):
 *   audit(options)            -> Promise<Report>
 *   buildFixPlan(report, {})  -> { markdown, script, actions }
 *   formatReport(report, fmt) -> string
 *
 * Adding a rule takes two files:
 *   1. create `lib/engine/rules/<id>.js` exporting `{ id, defaults, run(ctx) }`
 *   2. import it below and append it to `RULES`
 * Nothing else reads rule names, so ordering in `RULES` is the report order.
 *
 * The engine is strictly read-only. It never deletes, moves, writes or chmods
 * anything inside the audited tree; the only writer in this package is the CLI's
 * stdout.
 */

import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

import { composeTree, createClassifier } from './classify.js';
import { buildFixPlan } from './fixplan.js';
import { formatReport } from './format.js';
import { matchesAny } from './glob.js';
import { createHashPool } from './hashing.js';
import {
  findPolicy,
  loadPolicy,
  resolveAutofix,
  resolveClassification,
  resolveIgnore,
  resolveRuleConfigs,
} from './policy.js';
import { loadRegistry } from './registry.js';
import { checkAborted, roundMs } from './util.js';
import { walkTree } from './walk.js';

import * as ruleBackups from './rules/backups.js';
import * as ruleDocs from './rules/docs.js';
import * as ruleDuplicates from './rules/duplicates.js';
import * as ruleFamilies from './rules/families.js';
import * as ruleLargeFiles from './rules/large-files.js';
import * as ruleProtected from './rules/protected.js';
import * as ruleTopLevel from './rules/top-level.js';

/** Stable engine id written into every report. */
export const ENGINE_ID = 'dsh-layout-governor';

/** Engine version written into every report. */
export const ENGINE_VERSION = '0.1.0';

/** Rule modules in report order. */
export const RULES = [
  ruleTopLevel,
  ruleBackups,
  ruleDuplicates,
  ruleFamilies,
  ruleLargeFiles,
  ruleDocs,
  ruleProtected,
];

const SEVERITY_RANK = { fail: 0, warn: 1, info: 2 };
const DEFAULT_LIMITS = {
  maxEntries: 200000,
  maxDepth: 16,
  walkConcurrency: 16,
  hashConcurrency: 4,
};

/**
 * Audit a workspace tree against a policy file.
 *
 * @param {object} options
 * @param {string} options.root Audit root (absolute, or resolved from cwd).
 * @param {string} [options.policyPath] Defaults to `<root>/layout.policy.yml`.
 * @param {string} [options.registryPath] Defaults to the policy value, then `<root>/layout.registry.yml`.
 * @param {AbortSignal} [options.signal] Cancels the walk and any in-flight hashing.
 * @param {object} [options.limits] `{ maxEntries, maxDepth, walkConcurrency, hashConcurrency }`.
 * @param {string[]} [options.onlyRules] Restrict the run to these rule ids.
 * @param {boolean} [options.allRulesOff] Negative control: force every rule disabled.
 * @returns {Promise<object>} Report.
 */
export async function audit(options = {}) {
  const startedAt = Date.now();
  const signal = options.signal;
  checkAborted(signal);

  const root = path.resolve(options.root ?? process.cwd());
  // A walk over a path that does not exist finds nothing, and "found nothing" is
  // indistinguishable from "compliant". Refuse instead of reporting a green tree
  // for a typo: a governance tool that cannot tell those apart is worse than none.
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) {
    throw new Error(`audit root is not a directory: ${root}`);
  }
  // Discovery climbs from the root, so auditing a subdirectory obeys the
  // workspace policy above it without a flag.
  const located = await findPolicy({ root, explicitPath: options.policyPath });
  const policyPath = located.path;

  const policy = await loadPolicy({ policyPath });
  const classification = resolveClassification(policy.doc);
  const autofix = resolveAutofix(policy.doc);
  const ignore = resolveIgnore(policy.doc);
  const configs = resolveRuleConfigs(policy.doc, RULES, {
    allRulesOff: options.allRulesOff === true,
    onlyRules: options.onlyRules,
    policyPresent: policy.present,
  });

  const registryPath = resolveRegistryPath(policyPath, options, configs);
  const registry = await loadRegistry({ registryPath });

  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const skipPaths = new Set([policyPath, registryPath]);

  const walked = await walkTree({
    root,
    ignore,
    maxDepth: Number(limits.maxDepth),
    maxEntries: Number(limits.maxEntries),
    concurrency: resolveWalkConcurrency(limits),
    skipPaths,
    signal,
  });

  const entries = walked.entries;
  const files = entries.filter((entry) => entry.isFile);
  const byRel = new Map(entries.map((entry) => [entry.rel, entry]));
  const topLevel = entries.filter((entry) => entry.depth === 1);

  const backupsConfig = configs.get(ruleBackups.id);
  const classify = createClassifier({
    classification,
    backupRoots: backupsConfig && Array.isArray(backupsConfig.allowedRoots)
      ? backupsConfig.allowedRoots
      : ['_archive'],
  });

  const hashMode = options.hashMode === 'partial' ? 'partial' : 'full';
  const pool = createHashPool({
    concurrency: limits.hashConcurrency,
    mode: hashMode,
    signal,
  });
  const textCache = new Map();

  const ctx = {
    root,
    signal,
    options,
    limits,
    policy: {
      path: policyPath,
      present: policy.present,
      version: policy.version,
      inherited: located.inherited,
      ignore,
      classification,
    },
    registry,
    entries,
    files,
    topLevel,
    byRel,
    classify,
    rule: (id) => configs.get(id) ?? { enabled: false, severity: 'info' },
    hashMode,
    isRegenerable: (rel) => classify(rel) === 'regenerable',
    isProtectedPath: (rel) => matchesAny(rel, classification.protected),
    // Files, not bare paths: a signature needs the size to know where the tail is.
    hashAll: (files) => pool.hashAll(files),
    async readText(rel) {
      const abs = path.join(root, rel);
      if (textCache.has(abs)) return textCache.get(abs);
      let value = null;
      try {
        value = await readFile(abs, 'utf8');
      } catch {
        value = null;
      }
      textCache.set(abs, value);
      return value;
    },
  };

  const findings = [];
  const ruleReports = [];

  for (const rule of RULES) {
    const config = configs.get(rule.id);
    const ruleStart = Date.now();
    // Called even when disabled: the rule itself must honour `enabled`, so the
    // negative-control test proves gating rather than trusting the orchestrator.
    checkAborted(signal);
    const produced = await rule.run(ctx);
    const durationMs = roundMs(Date.now() - ruleStart);
    for (const item of produced) findings.push(item);
    ruleReports.push({
      id: rule.id,
      enabled: config.enabled,
      severity: config.severity,
      findings: produced.length,
      durationMs,
    });
  }

  findings.sort(compareFindings);

  const counts = { fail: 0, warn: 0, info: 0 };
  for (const item of findings) {
    if (counts[item.severity] !== undefined) counts[item.severity] += 1;
  }

  const hashStats = pool.stats();

  return {
    engine: ENGINE_ID,
    engineVersion: ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    root,
    policy: {
      path: policyPath,
      sha256: policy.sha256,
      version: policy.version,
      inherited: located.inherited,
      // Additive to the documented shape: without it the report cannot say
      // whether a policy existed at all, which changes how it must be read.
      present: policy.present,
    },
    registry: { path: registryPath, present: registry.present },
    autofix,
    overall: counts.fail > 0 ? 'fail' : counts.warn > 0 ? 'warn' : 'pass',
    counts,
    rules: ruleReports,
    findings,
    stats: {
      entries: walked.stats.entries,
      files: walked.stats.files,
      directories: walked.stats.directories,
      symlinks: walked.stats.symlinks,
      bytes: walked.stats.bytes,
      unreadable: walked.stats.unreadable ?? 0,
      hashMode,
      hashedFiles: hashStats.hashedFiles,
      hashedBytes: hashStats.hashedBytes,
      durationMs: roundMs(Date.now() - startedAt),
      truncated: walked.truncated,
    },
    composition: composeTree(files, classify),
  };
}

// `walkConcurrency` is the dedicated knob for directory traversal; older hosts
// only know `hashConcurrency`, so reuse it instead of silently guessing.
function resolveWalkConcurrency(limits) {
  const walk = Number(limits.walkConcurrency);
  if (Number.isFinite(walk) && walk > 0) return Math.floor(walk);
  const hash = Number(limits.hashConcurrency);
  if (Number.isFinite(hash) && hash > 0) return Math.floor(hash);
  return DEFAULT_LIMITS.walkConcurrency;
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
function resolveRegistryPath(policyPath, options, configs) {
  if (options.registryPath) return path.resolve(options.registryPath);
  const policyDir = path.dirname(policyPath);
  const config = configs.get(ruleLargeFiles.id);
  const declared = config && typeof config.registry === 'string' ? config.registry.trim() : '';
  if (declared !== '') return path.resolve(policyDir, declared);
  return path.join(policyDir, 'layout.registry.yml');
}

function compareFindings(a, b) {
  const rank = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
  if (rank !== 0) return rank;
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export { buildFixPlan, formatReport };
