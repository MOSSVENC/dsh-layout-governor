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
import { compareFindings, resolveRegistryPath, resolveWalkConcurrency } from './audit-order.js';
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
const ENGINE_ID = 'dsh-layout-governor';

/** Engine version written into every report. */
const ENGINE_VERSION = '0.2.0';

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
 * @param {string} [options.query] Skip the walk and answer one index query instead.
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
  // This plugin writes nothing into the tree it audits: no database, no cache file.
  // It is a fixture, not an index. Only the policy and the registry are skipped.
  const skipPaths = new Set([policyPath, registryPath]);

  const walked = await walkTree({
    root,
    ignore,
    maxDepth: Number(limits.maxDepth),
    maxEntries: Number(limits.maxEntries),
    concurrency: resolveWalkConcurrency(limits, DEFAULT_LIMITS.walkConcurrency),
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
    hashAll: (files, stage) => pool.hashAll(files, stage),
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
  /** Whether this run judged anything at all. */
  let anyRuleEnabled = false;

  for (const rule of RULES) {
    const config = configs.get(rule.id);
    const ruleStart = Date.now();
    // Called even when disabled: the rule itself must honour `enabled`, so the
    // negative-control test proves gating rather than trusting the orchestrator.
    checkAborted(signal);
    const produced = await rule.run(ctx);
    const durationMs = roundMs(Date.now() - ruleStart);
    for (const item of produced) findings.push(item);
    if (config.enabled) anyRuleEnabled = true;
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

  const report = {
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
    protection: {
      patterns: classification.protected,
      // The patterns are a rule; these are the paths that actually matched. A
      // mover must not guess from a glob whether a subtree holds something
      // irreplaceable — it asks this list instead.
      paths: entries
        .filter((entry) => matchesAny(entry.rel, classification.protected))
        .map((entry) => entry.path)
        .slice(0, 500),
    },
    autofix,
    // A partial audit may not claim compliance *about the rules it ran*. With every
    // rule switched off nothing was judged at all, so the negative control has to
    // stay green — the truncation is reported in `stats`, not as a verdict.
    overall:
      counts.fail > 0
        ? 'fail'
        : counts.warn > 0
          ? 'warn'
          : anyRuleEnabled && (walked.truncated || (walked.stats.unreadable ?? 0) > 0)
            ? 'warn'
            : 'pass',
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

  return report;
}

export { buildFixPlan, findPolicy, formatReport, loadPolicy };
