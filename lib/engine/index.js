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
import {
  indexStats,
  labelClasses,
  lookupHash,
  lookupSignature,
  openIndexSelfHealing,
  pruneRuns,
  queryIndex,
  recordRun,
  syncFiles,
  syncRegistry,
} from './store.js';
import {
  codeNeedsParse,
  codeStats,
  pruneCode,
  queryDependents,
  queryImports,
  querySymbols,
  writeCodeFile,
} from './store-code.js';
import { MAX_CODE_BYTES, extract, languageOf } from './codegraph.js';
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
export const ENGINE_VERSION = '0.2.0';

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
 * @param {string} [options.storePath] SQLite index to read from and write back to.
 * @param {boolean} [options.code] Parse changed source files into the index (default on).
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
  const storePath =
    typeof options.storePath === 'string' && options.storePath !== ''
      ? path.resolve(options.storePath)
      : null;
  // The index is the plugin's own artifact. Skip it everywhere — including the CLI,
  // which passes no `storePath` — so the CLI and the panel reach the same verdict
  // about the same tree instead of disagreeing about a file the plugin wrote itself.
  const INDEX_NAME = '.layout-index.db';
  const skipPaths = new Set([
    policyPath,
    registryPath,
    storePath,
    `${storePath}-wal`,
    `${storePath}-shm`,
    path.join(root, INDEX_NAME),
    path.join(root, `${INDEX_NAME}-wal`),
    path.join(root, `${INDEX_NAME}-shm`),
  ]);

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
  // An index that cannot be opened degrades the audit, it does not fail it: the
  // findings are still correct without a store, they are merely not persisted.
  let index = null;
  let indexError = null;
  if (storePath !== null) {
    try {
      index = openIndexSelfHealing(storePath);
    } catch (error) {
      indexError = String(error instanceof Error ? error.message : error);
    }
  }
  const pool = createHashPool({
    concurrency: limits.hashConcurrency,
    mode: hashMode,
    signal,
    ...(index !== null
      ? {
          lookup: (file, size, mtime) => lookupHash(index, file, size, mtime),
          lookupSignature: (file, size, mtime) => lookupSignature(index, file, size, mtime),
        }
      : {}),
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

  if (index === null && storePath !== null) {
    report.index = { path: storePath, error: indexError ?? 'index unavailable' };
  }
  if (index !== null) {
    try {
      syncFiles(index, entries, pool.digests, pool.signatures);
      labelClasses(
        index,
        entries.map((entry) => ({ path: entry.path, class: classify(entry.rel) })),
      );
      syncRegistry(index, registry.entries ?? []);

      const code = options.code === false ? null : await indexCode(index, files, classify, limits);
      const runId = recordRun(index, report);
      // Prune *after* the insert, or the new run is the one that gets dropped.
      pruneRuns(index, limits.maxRuns ?? 50);
      report.index = {
        path: storePath,
        run: runId,
        indexedAt: new Date().toISOString(),
        ...indexStats(index),
        ...(code !== null ? code : {}),
        ...codeStats(index),
      };
    } catch (error) {
      // An index that cannot be written must not invalidate the audit itself.
      report.index = { path: storePath, error: String(error) };
    } finally {
      index.close();
    }
  }

  return report;
}

/**
 * Parse changed source files into the index.
 *
 * Only files whose size and mtime changed are re-read, the same rule that saves
 * hashing: an agent asking "where is `runAudit` defined" should get an answer from
 * a table, not from a grep over the workspace.
 *
 * @param {object} index Open index handle.
 * @param {object[]} files Walked files.
 * @param {(rel: string) => string} classify Path classifier.
 * @param {object} limits Resolved limits.
 * @returns {Promise<{ codeParsed: number, codeSkipped: number }>}
 */
async function indexCode(index, files, classify, limits) {
  const maxCodeFiles = Number.isFinite(limits.maxCodeFiles) ? limits.maxCodeFiles : 20000;
  const live = new Set();
  let parsed = 0;
  let skipped = 0;

  for (const file of files) {
    const lang = languageOf(file.rel, file.ext, file.size);
    if (lang === null) continue;
    // A virtualenv is not the workspace's code; it is a rebuildable artifact.
    if (classify(file.rel) === 'regenerable') {
      skipped += 1;
      continue;
    }
    live.add(file.path);
    if (!codeNeedsParse(index, file.path, file.size, file.mtimeMs)) continue;
    if (parsed >= maxCodeFiles) {
      skipped += 1;
      continue;
    }
    let text;
    try {
      text = await readFile(file.path, 'utf8');
    } catch {
      skipped += 1;
      continue;
    }
    if (text.length > MAX_CODE_BYTES) {
      skipped += 1;
      continue;
    }
    const { symbols, imports } = extract(text, lang);
    writeCodeFile(index, {
      path: file.path,
      lang,
      size: file.size,
      mtime: file.mtimeMs,
      symbols,
      imports,
    });
    parsed += 1;
  }

  pruneCode(index, live);
  return { codeParsed: parsed, codeSkipped: skipped };
}

/**
 * Answer one query against an existing index without walking anything.
 *
 * This is the `codegraph_context` half of the analogy: an agent that wants to
 * know "which files over 1 GiB are classified regenerable" should not pay for a
 * 150k-entry walk to find out.
 *
 * @param {object} options
 * @param {string} options.storePath Index file.
 * @param {object} [options.filters] Query filters, see `queryIndex`.
 * @returns {{ rows: object[], stats: object }} Rows plus index totals.
 */
export function query(options) {
  const index = openIndexSelfHealing(path.resolve(options.storePath));
  try {
    return { rows: queryIndex(index, options.filters ?? {}), stats: indexStats(index) };
  } finally {
    index.close();
  }
}

/**
 * Answer one code-graph question against the index: symbols, imports, or the
 * files that depend on a module.
 *
 * @param {object} options
 * @param {string} options.storePath Index file.
 * @param {'symbol'|'imports'|'dependents'|'file'} options.mode Question to ask.
 * @param {object} [options.filters] Mode-specific filters.
 * @returns {{ rows: object[], stats: object }} Rows plus code totals.
 */
export function codeQuery(options) {
  const index = openIndexSelfHealing(path.resolve(options.storePath));
  try {
    const mode = options.mode ?? 'symbol';
    const filters = options.filters ?? {};
    let rows;
    if (mode === 'imports') rows = queryImports(index, filters);
    else if (mode === 'dependents') rows = queryDependents(index, filters.target ?? '', filters.limit);
    else if (mode === 'file') rows = querySymbols(index, { path: filters.path, limit: filters.limit });
    else rows = querySymbols(index, filters);
    return { rows, stats: codeStats(index) };
  } finally {
    index.close();
  }
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
