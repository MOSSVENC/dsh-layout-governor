/**
 * Host half of the layout-governor bundle.
 *
 * Wiring only: resolve a root, run the engine behind a short-lived cache, hand the
 * same runner to the tool and to the panel route, and keep the report fresh without
 * being asked. The decisions live in `lib/host/*` and the work happens in
 * `lib/engine/*`, so this file stays small enough to read in one screen.
 *
 * There are three triggers, and only one of them is a human:
 *   1. activation warms the cache for the default root (no click, no flag);
 *   2. every finished tool call that can write arms one debounced refresh;
 *   3. the tool and the panel route read whatever the cache holds.
 *
 * @module dsh-layout-governor
 */

import path from 'node:path';

import { audit, buildFixPlan, findPolicy, loadPolicy } from './engine/index.js';
import { createAuditTool } from './host/audit-tool.js';
import { applyAutoActions } from './host/autofix.js';
import { createReportCache } from './host/report-cache.js';
import { mountReportRoute } from './host/report-route.js';
import { resolveRoot, typedField } from './host/root.js';
import { createChangeWatcher } from './host/watcher.js';
import { createWriteGuard, guardSettings } from './host/guard.js';

/** Loader row name; the client factory uses the same id. */
export const name = 'layout-governor';

/**
 * The live instance, held on the global so it survives a module reload.
 *
 * A link-installed bundle is watched by HMR: every save in the checkout re-executes
 * this module, which resets module-level variables but not `globalThis`. Keeping the
 * teardown there is what lets the new generation dispose the old one. Without it,
 * the second activation collides on `layout_audit` —
 * `tool "layout_audit" is already registered` — and editing the plugin damages the
 * profile that is running it.
 */
const ACTIVE = Symbol.for('dsh-layout-governor.active');

/**
 * Dispose the previous generation, if this module has an ancestor.
 * @returns {void}
 */
function disposePrevious() {
  const previous = globalThis[ACTIVE];
  if (typeof previous !== 'function') return;
  try {
    previous();
  } catch {
    // A failed teardown must not block the replacement.
  }
  delete globalThis[ACTIVE];
}

/** Services required before {@link apply} runs. */
export const inject = ['tools'];

/**
 * Cache lifetime used when the row does not configure one.
 *
 * Five minutes, not thirty seconds: the panel polls, and every cache miss on a
 * 122k-entry tree is a 30-second walk. A panel that re-walks the disk while the
 * user is working is an anti-feature, so freshness is traded for a quiet machine
 * and an explicit re-scan is one click away.
 */
const DEFAULT_CACHE_MS = 300_000;


/**
 * Resource ceilings for scans nobody asked for.
 *
 * An automatic scan is a courtesy, and courtesy must not cost what a deliberate
 * one may. On this machine a full walk of a 150k-entry tree on a DrvFs mount costs
 * 35-55 s and pins the disk the whole time — unacceptable when the trigger was
 * somebody saving a file. So an automatic scan walks a bounded slice: the top of
 * the tree, where misplaced backups and stale documentation actually live, and
 * where 6k entries cost about a second. A deliberate scan is unbounded and proven.
 */
const AUTO_BUDGET = { maxEntries: 6000, maxDepth: 6, walkConcurrency: 12, hashConcurrency: 2 };

/** Bounds the automatic budget may grow to, and shrink to, as it tunes itself. */
const AUTO_CAP_RANGE = { minEntries: 1500, maxEntries: 20000, minDepth: 4, maxDepth: 10 };

/** A bounded scan slower than this gives back budget; a fast one earns more. */
const AUTO_SLOW_MS = 5000;
const AUTO_FAST_MS = 1500;

/** Quiet period after the last write before the tree is re-walked. */
const DEFAULT_DEBOUNCE_MS = 3_000;

/** Delay before the activation scan, so it never competes with session start. */
const DEFAULT_BOOT_DELAY_MS = 400;

/** How many distinct roots stay watched; the panel only ever shows one. */
const MAX_WATCHED_ROOTS = 3;

/**
 * Floor between two automatic scans. A busy session finishes a tool call every few
 * seconds, and each one would otherwise start a 35-second walk of a 122k-entry
 * tree: an automatic feature that hammers the disk is worse than a manual one.
 */
const DEFAULT_MIN_RESCAN_MS = 60_000;

/**
 * Read a numeric config value with a fallback.
 * @param {object} config Row config.
 * @param {string} key Field name.
 * @param {number} fallback Default when absent or invalid.
 * @returns {number}
 */
function number(config, key, fallback) {
  const value = typedField(config, key, 'number');
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Translate the row config plus one call's options into engine options.
 * @param {object} config Bundle row config.
 * @param {object} options Call options.
 * @returns {object} Options accepted by `audit`.
 */
function engineOptions(config, options, autoBudget) {
  const auto = options.automatic === true;
  const policyPath = options.policyPath ?? typedField(config, 'policy', 'string');
  const registryPath = options.registryPath ?? typedField(config, 'registry', 'string');
  const limits = {
    ...(typedField(config, 'maxEntries', 'number') !== undefined
      ? { maxEntries: typedField(config, 'maxEntries', 'number') }
      : {}),
    ...(typedField(config, 'maxDepth', 'number') !== undefined
      ? { maxDepth: typedField(config, 'maxDepth', 'number') }
      : {}),
    ...(typedField(config, 'hashConcurrency', 'number') !== undefined
      ? { hashConcurrency: typedField(config, 'hashConcurrency', 'number') }
      : {}),
    // One knob bounds both the directory walk and the hashing pool: on a slow
    // network mount the walk dominates, and 16 measured ~10x over serial.
    ...(typedField(config, 'walkConcurrency', 'number') !== undefined
      ? { walkConcurrency: typedField(config, 'walkConcurrency', 'number') }
      : {}),
  };
  return {
    ...(policyPath !== undefined ? { policyPath: path.resolve(policyPath) } : {}),
    ...(registryPath !== undefined ? { registryPath: path.resolve(registryPath) } : {}),
    ...(options.onlyRules !== undefined ? { onlyRules: options.onlyRules } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(auto ? { hashMode: 'partial' } : {}),
    ...(auto ? { limits: { ...(autoBudget ?? AUTO_BUDGET) } } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
  };
}

/**
 * Register the audit tool, the panel route, and the automatic refresh.
 * @param {object} ctx Registrant context carrying `tools`, and `on` for events.
 * @param {object} [config] Row config: `root`, `policy`, `registry`, `maxEntries`,
 *   `maxDepth`, `hashConcurrency`, `walkConcurrency`, `cacheMs`, `autoScan`,
 *   `watchDebounceMs`, `bootDelayMs`.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  // Replace, never stack. Disposing first also stops the previous watcher and any
  // pending timer, which is what kept a reloaded plugin scanning forever.
  disposePrevious();
  const teardown = [];
  const teardownAll = () => {
    for (const dispose of teardown) {
      try {
        dispose();
      } catch {
        // Teardown is best-effort by design.
      }
    }
    teardown.length = 0;
  };
  globalThis[ACTIVE] = teardownAll;
  const configuredCache = typedField(config, 'cacheMs', 'number');
  const cache = createReportCache({
    ...(Number.isFinite(configuredCache) && configuredCache >= 0 ? { maxAgeMs: configuredCache } : {}),
  });

  /** Roots the user has actually looked at; the watcher refreshes these. */
  const watched = new Set();

  /**
   * Remember a root, bounded so a stray audit of `/tmp` does not get re-walked.
   * @param {string} root Absolute root.
   */
  function watch(root) {
    watched.delete(root);
    watched.add(root);
    while (watched.size > MAX_WATCHED_ROOTS) {
      const oldest = watched.values().next();
      if (oldest.done === true) break;
      watched.delete(oldest.value);
    }
  }

  /**
   * Cached audit runner: identical requests join one scan.
   * @param {string} root Absolute tree root.
   * @param {object} options Call options.
   * @returns {Promise<object>} The report.
   */
  const runAudit = (root, options = {}) => {
    watch(root);
    // One slot per tree, as before: an automatic scan and a deliberate one describe
    // the same workspace. What stops a bounded report from answering a deliberate
    // request is the `accept` predicate below, not a separate key — with separate
    // keys an automatic scan could never refresh what the tool reads.
    const key = [
      root,
      options.policyPath ?? '',
      options.registryPath ?? '',
      (options.onlyRules ?? []).join(','),
    ].join('\u0000');
    return cache.read(key, () => audit({ root, ...engineOptions(config, options, autoBudget) }), {
      force: options.force === true,
      // A bounded report is not an answer to "audit this tree": it is a status.
      accept: (report) => options.automatic === true || report.stats?.truncated !== true,
    });
  };

  const resolve = (requested, session) => resolveRoot(ctx, config, requested, session);

  /**
   * Re-scan every watched root and, when the policy allows it, apply the
   * reversible part of the plan.
   *
   * A refresh must never disturb the session: a scan that throws is logged and
   * skipped, because the alternative is a plugin that breaks a turn.
   *
   * @param {{ reason: string, heal: boolean }} request Refresh request.
   * @returns {Promise<void>}
   */
  async function refresh(request) {
    if (request.heal === true) {
      const wait = lastScanAt + effectiveIntervalMs - Date.now();
      if (wait > 0) {
        // Not dropped: the last change still gets its scan once the floor passes.
        if (pendingTimer === null) {
          pendingTimer = setTimeout(() => {
            pendingTimer = null;
            void refresh({ reason: request.reason, heal: true, automatic: true });
          }, wait);
          if (typeof pendingTimer?.unref === 'function') pendingTimer.unref();
        }
        return;
      }
    }
    if (scanning) return;
    scanning = true;
    let elapsed = 0;
    try {
      elapsed = await scanWatchedRoots(request);
    } finally {
      scanning = false;
      lastScanAt = Date.now();
      // Back off when a scan is expensive; recover when it is not. A tree that
      // takes 35 s to walk must not be walked every minute of a working session.
      if (request.heal === true) {
        effectiveIntervalMs =
          elapsed > 20_000
            ? Math.min(effectiveIntervalMs * 2, 30 * 60_000)
            : Math.max(minRescanMs, effectiveIntervalMs / 2);
      }
      if (request.automatic === true) tuneAutoBudget(elapsed);
    }
  }

  /**
   * Grow or shrink the automatic scan's ceiling to keep it near a second.
   * @param {number} elapsed Milliseconds the last bounded scan took.
   * @returns {void}
   */
  function tuneAutoBudget(elapsed) {
    if (elapsed > AUTO_SLOW_MS) {
      autoBudget.maxEntries = Math.max(AUTO_CAP_RANGE.minEntries, Math.floor(autoBudget.maxEntries / 2));
      autoBudget.maxDepth = Math.max(AUTO_CAP_RANGE.minDepth, autoBudget.maxDepth - 1);
    } else if (elapsed < AUTO_FAST_MS) {
      autoBudget.maxEntries = Math.min(AUTO_CAP_RANGE.maxEntries, Math.ceil(autoBudget.maxEntries * 2));
      autoBudget.maxDepth = Math.min(AUTO_CAP_RANGE.maxDepth, autoBudget.maxDepth + 1);
    }
  }

  /**
   * Walk every watched root once and heal what the policy allows.
   * @param {{ reason: string, heal: boolean, automatic?: boolean }} request Refresh request.
   * @returns {Promise<number>} Milliseconds spent scanning.
   */
  async function scanWatchedRoots(request) {
    let elapsed = 0;
    for (const root of [...watched]) {
      try {
        const startedAt = Date.now();
        const report = await runAudit(root, { force: true, automatic: request.automatic === true });
        elapsed += Date.now() - startedAt;
        if (request.heal !== true || report.autofix?.enabled !== true) continue;
        const plan = buildFixPlan(report);
        const outcome = await applyAutoActions(report, { actions: plan.actions });
        if (outcome.moved.length > 0) {
          ctx.logger?.info?.(`layout-governor: moved ${outcome.moved.length} path(s) into _archive`);
          // One cheap re-scan so the cache reflects the tree that exists now. It
          // is deliberately the cheap mode: the moves are the point, not a
          // second full-hash pass over everything that did not move.
          await runAudit(root, { force: true, automatic: true });
        }
      } catch (error) {
        ctx.logger?.warn?.(`layout-governor: refresh failed for ${root}: ${String(error)}`);
      }
    }
    return elapsed;
  }

  const debounceMs = number(config, 'watchDebounceMs', DEFAULT_DEBOUNCE_MS);
  const minRescanMs = number(config, 'minRescanIntervalMs', DEFAULT_MIN_RESCAN_MS);
  // Self-tuning ceiling for automatic scans: it converges on "about a second" on
  // whatever filesystem the workspace happens to live on, without a config knob
  // nobody would know how to set.
  const autoBudget = { ...AUTO_BUDGET };
  /** Grows when a scan turns out to be expensive; capped, and reset by a fast one. */
  let effectiveIntervalMs = minRescanMs;
  /** Set while a scan walks, so two refreshes never overlap. */
  let scanning = false;
  let lastScanAt = 0;
  /** A throttled request waits here instead of being dropped. */
  let pendingTimer = null;
  const watcher = createChangeWatcher({
    debounceMs,
    onChange: () => {
      void refresh({ reason: 'workspace-changed', heal: true, automatic: true });
    },
  });

  // 1. Warm the cache at activation: the panel has something to draw on open, and
  //    a session that asks the tool immediately does not pay for a cold walk.
  watch(resolve(undefined));
  if (typedField(config, 'autoScan', 'boolean') !== false) {
    const bootDelayMs = number(config, 'bootDelayMs', DEFAULT_BOOT_DELAY_MS);
    const bootDispose = ctx.effect(() => {
      const handle = setTimeout(() => {
        void refresh({ reason: 'activation', heal: false, automatic: true });
      }, bootDelayMs);
      if (typeof handle?.unref === 'function') handle.unref();
      return () => clearTimeout(handle);
    }, 'layout-governor: activation scan');
    if (typeof bootDispose === 'function') teardown.push(bootDispose);
  }

  // 2. Every finished tool call that can write arms one debounced refresh. This is
  //    the whole "self-triggering" claim: no flag, no click, no schedule the user
  //    has to remember.
  if (typedField(config, 'autoScan', 'boolean') !== false) {
    try {
      // Every side effect this plugin creates lands in `teardown`. The earlier
      // version only disposed the three tools, so a reload left the route, the
      // listener and any pending timer alive — the shape that took DSH down.
      teardown.push(() => watcher.dispose());
      teardown.push(() => {
        if (pendingTimer !== null) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
      });
      const watchDispose = ctx.effect(() => {
        const dispose = ctx.on('tools/result', (exec) => {
          watcher.notify(exec?.name);
        });
        return () => {
          if (typeof dispose === 'function') dispose();
        };
      }, 'layout-governor: change watcher');
      if (typeof watchDispose === 'function') teardown.push(watchDispose);
    } catch {
      // A host without the event still gets the tool, the route and the panel.
    }
  }

  try {
    teardown.push(ctx.tools.register(createAuditTool({ runAudit, resolveRoot: resolve })));
  } catch (error) {
    // A tool that cannot register is a degraded plugin, not a broken profile: the
    // route and the panel still work, and the reason is logged once.
    ctx.logger?.warn?.(`layout-governor: tool registration skipped: ${String(error)}`);
  }
  /**
   * Roots the panel route may audit: the configured root plus every open workspace.
   * The request body is untrusted, so it may only name one of these.
   * @returns {string[]} Absolute directories.
   */
  function allowedRoots() {
    const roots = new Set();
    const configured = typedField(config, 'root', 'string');
    if (typeof configured === 'string' && configured.trim() !== '') roots.add(path.resolve(configured));
    try {
      const registry = ctx.get('workspaceRegistry');
      const workspaces = registry?.list?.();
      if (Array.isArray(workspaces)) {
        for (const workspace of workspaces) {
          if (typeof workspace?.path === 'string' && workspace.path !== '') roots.add(path.resolve(workspace.path));
        }
      }
    } catch {
      // No registry: the configured root is the only allowance.
    }
    return [...roots];
  }

  // The gate: the only part of this plugin that acts before a write lands.
  const guardDoc = { current: {} };
  let guardLoadedFor = null;

  /**
   * Re-read the policy the guard enforces. Cheap enough to run on every
   * activation and every workspace change; stale policy is worse than no gate.
   * @returns {Promise<void>}
   */
  async function refreshGuardPolicy() {
    try {
      const root = resolve(undefined);
      if (guardLoadedFor === root && guardDoc.current !== undefined) {
        // Same tree, still reload: a policy edit is the point.
      }
      const located = await findPolicy({
        root,
        ...(typedField(config, 'policy', 'string') !== undefined
          ? { explicitPath: typedField(config, 'policy', 'string') }
          : {}),
      });
      if (located.present !== true) {
        guardDoc.current = {};
        guardLoadedFor = root;
        return;
      }
      const policy = await loadPolicy({ policyPath: located.path });
      guardDoc.current = policy.doc ?? {};
      guardLoadedFor = root;
    } catch {
      // Failing open: a gate that cannot read its policy must not block work.
      guardDoc.current = {};
    }
  }

  const writeGuard = createWriteGuard({
    root: (session) => resolve(undefined, session),
    policy: () => guardSettings(guardDoc.current),
    baseOf: (session) => resolve(undefined, session),
  });

  try {
    teardown.push(
      ctx.on('tools/pre-execute', (exec, next) => writeGuard(exec, next)),
    );
  } catch {
    // A host without the waterfall still gets audit, query and the panel.
  }

  void refreshGuardPolicy();

  const unmountRoute = mountReportRoute(ctx, {
    runAudit,
    resolveRoot: resolve,
    allowedRoots,
  });
  teardown.push(unmountRoute);

  // Reload the guard's policy whenever the tree changes, so a policy edit is
  // enforced on the next tool call rather than the next restart.
  teardown.push(() => {
    guardDoc.current = {};
  });
}
