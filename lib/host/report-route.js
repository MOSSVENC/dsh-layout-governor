/**
 * The panel's data surface: one exact `/api` route.
 *
 * The panel never parses the tree and never recomputes a verdict; it renders what
 * this route returns. Keeping the panel and the tool on the same producer is what
 * makes "the sidebar says red, the tool said pass" impossible.
 */

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
export function createReportHandler({ runAudit, resolveRoot }) {
  return async function handleReport(request) {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    // No session behind an HTTP request: the resolver falls back to the open
    // workspace, which is what a panel is looking at.
    const root = resolveRoot(typeof body?.root === 'string' ? body.root : undefined);
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
