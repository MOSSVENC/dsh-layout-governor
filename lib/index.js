/**
 * Host half of the layout-governor bundle.
 *
 * Wiring only: resolve a root, run the engine behind a short-lived cache, and
 * hand the same runner to the tool and to the panel route. The decisions live in
 * `lib/host/*` and the work happens in `lib/engine/*`, so this file stays small
 * enough to read in one screen.
 *
 * @module dsh-layout-governor
 */

import path from 'node:path';

import { audit } from './engine/index.js';
import { createAuditTool } from './host/audit-tool.js';
import { createReportCache } from './host/report-cache.js';
import { mountReportRoute } from './host/report-route.js';
import { resolveRoot, typedField } from './host/root.js';

/** Loader row name; the client factory uses the same id. */
export const name = 'layout-governor';

/** Services required before {@link apply} runs. */
export const inject = ['tools'];

/** Cache lifetime used when the row does not configure one. */
const DEFAULT_CACHE_MS = 30_000;

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
 * Register the audit tool and the panel route.
 * @param {object} ctx Registrant context carrying the `tools` service.
 * @param {object} [config] Row config: `root`, `policy`, `registry`, `maxEntries`,
 *   `maxDepth`, `hashConcurrency`, `walkConcurrency`, `cacheMs`.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const configuredCache = typedField(config, 'cacheMs', 'number');
  const cache = createReportCache({
    ...(Number.isFinite(configuredCache) && configuredCache >= 0 ? { maxAgeMs: configuredCache } : {}),
  });

  /**
   * Cached audit runner: identical requests join one scan.
   * @param {string} root Absolute tree root.
   * @param {object} options Call options.
   * @returns {Promise<object>} The report.
   */
  const runAudit = (root, options = {}) => {
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

  ctx.tools.register(createAuditTool({ runAudit, resolveRoot: resolve }));
  mountReportRoute(ctx, { runAudit, resolveRoot: resolve });
}
