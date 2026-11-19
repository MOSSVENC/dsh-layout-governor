/**
 * The panel's data surface: one exact `/api` route.
 *
 * The panel never parses the tree and never recomputes a verdict; it renders what
 * this route returns. Keeping the panel and the tool on the same producer is what
 * makes "the sidebar says red, the tool said pass" impossible.
 */

import path from 'node:path';

import { buildFixPlan } from '../engine/index.js';

/** Route path, registered on the shared connection channel. */
export const REPORT_PATH = '/api/layout-governor/report';

/** A cold scan of a large tree is slow; the route gives up long before the socket does. */
const SCAN_TIMEOUT_MS = 600_000;

/**
 * JSON response with the shared no-store policy.
 * @param {object} value Response body.
 * @param {number} [status] HTTP status.
 * @returns {Response} The response.
 */
function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

/**
 * Create the route handler.
 * @param {object} deps
 * @param {(root: string, options: object) => Promise<object>} deps.runAudit Cached audit runner.
 * @param {(requested: unknown) => string} deps.resolveRoot Root resolver bound to the row config.
 * @returns {(request: Request) => Promise<Response>} Fetch-shaped handler.
 */
export function createReportHandler({ runAudit, resolveRoot, allowedRoots }) {
  /** At most one scan per window: a POST must not become a disk stressor. */
  let lastCallAt = 0;
  const MIN_INTERVAL_MS = 2000;

  /**
   * Whether a requested root may be audited for an unauthenticated body.
   *
   * The body is untrusted. Without this check any caller could enumerate any
   * readable directory on the host through one POST; only the configured root and
   * the open workspaces are acceptable.
   *
   * @param {string} candidate Absolute candidate root.
   * @returns {boolean} True when the candidate is inside an allowed root.
   */
  function permitted(candidate) {
    if (typeof allowedRoots !== 'function') return true;
    const roots = allowedRoots();
    if (!Array.isArray(roots) || roots.length === 0) return true;
    return roots.some((base) => candidate === base || candidate.startsWith(`${base}${path.sep}`));
  }

  return async function handleReport(request) {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const now = Date.now();
    if (body?.force !== true && now - lastCallAt < MIN_INTERVAL_MS) {
      return json(
        {
          ok: false,
          error: { code: 'layout-governor/too-frequent', message: 'A scan just ran; wait a moment.' },
        },
        429,
      );
    }

    // No session behind an HTTP request: the resolver falls back to the open
    // workspace, which is what a panel is looking at.
    const root = resolveRoot(typeof body?.root === 'string' ? body.root : undefined);
    if (!permitted(root)) {
      return json(
        {
          ok: false,
          error: {
            code: 'layout-governor/root-not-permitted',
            message: 'That directory is not one of this profile\u2019s workspaces.',
          },
        },
        403,
      );
    }
    lastCallAt = now;
    try {
      const report = await runAudit(root, {
        force: body?.force === true,
        signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
      });
      return json({ ok: true, value: { ...report, fixPlan: buildFixPlan(report) } });
    } catch (error) {
      return json({
        ok: false,
        error: {
          code: 'layout-governor/scan-failed',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };
}

/**
 * Register the route when the profile carries a connection channel.
 * @param {object} ctx Registrant context.
 * @param {object} deps Same dependencies as {@link createReportHandler}.
 * @returns {() => void} Disposer that removes the route from this context.
 */
export function mountReportRoute(ctx, deps) {
  let dispose = null;
  ctx.inject(['connection'], (scoped) => {
    const connection = scoped.get('connection');
    if (connection === undefined || typeof connection.fetch?.register !== 'function') return;
    dispose = scoped.effect(
      () =>
        connection.fetch.register({
          path: REPORT_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: createReportHandler(deps),
        }),
      'layout-governor: report route',
    );
  });
  return () => {
    if (typeof dispose === 'function') dispose();
    else if (dispose !== null) Promise.resolve(dispose).catch(() => {});
  };
}
