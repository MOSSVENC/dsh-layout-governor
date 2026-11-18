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

import { audit, buildFixPlan } from './engine/index.js';
import { createAuditTool } from './host/audit-tool.js';
import { applyAutoActions } from './host/autofix.js';
import { createReportCache } from './host/report-cache.js';
import { mountReportRoute } from './host/report-route.js';
import { resolveRoot, typedField } from './host/root.js';
import { createChangeWatcher } from './host/watcher.js';

/** Loader row name; the client factory uses the same id. */
export const name = 'layout-governor';

/** Services required before {@link apply} runs. */
export const inject = ['tools'];

/** Cache lifetime used when the row does not configure one. */
const DEFAULT_CACHE_MS = 30_000;

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
function engineOptions(config, options) {
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
    const key = [
      root,
      options.policyPath ?? '',
      options.registryPath ?? '',
      (options.onlyRules ?? []).join(','),
    ].join('\u0000');
    return cache.read(key, () => audit({ root, ...engineOptions(config, options) }), {
      force: options.force === true,
    });
  };

  const resolve = (requested) => resolveRoot(ctx, config, requested);

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
      const wait = lastScanAt + minRescanMs - Date.now();
      if (wait > 0) {
        // Not dropped: the last change still gets its scan once the floor passes.
        if (pendingTimer === null) {
          pendingTimer = setTimeout(() => {
            pendingTimer = null;
            void refresh({ reason: request.reason, heal: true });
          }, wait);
          if (typeof pendingTimer?.unref === 'function') pendingTimer.unref();
        }
        return;
      }
    }
    if (scanning) return;
    scanning = true;
    try {
      await scanWatchedRoots(request);
    } finally {
      scanning = false;
      lastScanAt = Date.now();
    }
  }

  /**
   * Walk every watched root once and heal what the policy allows.
   * @param {{ reason: string, heal: boolean }} request Refresh request.
   * @returns {Promise<void>}
   */
  async function scanWatchedRoots(request) {
    for (const root of [...watched]) {
      try {
        const report = await runAudit(root, { force: true });
        if (request.heal !== true || report.autofix?.enabled !== true) continue;
        const plan = buildFixPlan(report);
        const outcome = await applyAutoActions(report, { actions: plan.actions });
        if (outcome.moved.length > 0) {
          ctx.logger?.info?.(`layout-governor: moved ${outcome.moved.length} path(s) into _archive`);
          // Re-scan once so the cache, the panel and the next tool answer all
          // describe the tree that exists now, not the one that just changed.
          await runAudit(root, { force: true });
        }
      } catch (error) {
        ctx.logger?.warn?.(`layout-governor: refresh failed for ${root}: ${String(error)}`);
      }
    }
  }

  const debounceMs = number(config, 'watchDebounceMs', DEFAULT_DEBOUNCE_MS);
  const minRescanMs = number(config, 'minRescanIntervalMs', DEFAULT_MIN_RESCAN_MS);
  /** Set while a scan walks, so two refreshes never overlap. */
  let scanning = false;
  let lastScanAt = 0;
  /** A throttled request waits here instead of being dropped. */
  let pendingTimer = null;
  const watcher = createChangeWatcher({
    debounceMs,
    onChange: () => {
      void refresh({ reason: 'workspace-changed', heal: true });
    },
  });

  // 1. Warm the cache at activation: the panel has something to draw on open, and
  //    a session that asks the tool immediately does not pay for a cold walk.
  watch(resolve(undefined));
  if (typedField(config, 'autoScan', 'boolean') !== false) {
    const bootDelayMs = number(config, 'bootDelayMs', DEFAULT_BOOT_DELAY_MS);
    ctx.effect(() => {
      const handle = setTimeout(() => {
        void refresh({ reason: 'activation', heal: false });
      }, bootDelayMs);
      if (typeof handle?.unref === 'function') handle.unref();
      return () => clearTimeout(handle);
    }, 'layout-governor: activation scan');
  }

  // 2. Every finished tool call that can write arms one debounced refresh. This is
  //    the whole "self-triggering" claim: no flag, no click, no schedule the user
  //    has to remember.
  if (typedField(config, 'autoScan', 'boolean') !== false) {
    try {
      ctx.effect(() => {
        const dispose = ctx.on('tools/result', (exec) => {
          watcher.notify(exec?.name);
        });
        return () => {
          watcher.dispose();
          if (typeof dispose === 'function') dispose();
        };
      }, 'layout-governor: change watcher');
    } catch {
      // A host without the event still gets the tool, the route and the panel.
    }
  }

  ctx.tools.register(createAuditTool({ runAudit, resolveRoot: resolve }));
  mountReportRoute(ctx, { runAudit, resolveRoot: resolve });
}
