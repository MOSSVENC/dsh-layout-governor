/**
 * Host half of the layout-governor bundle.
 *
 * Responsibilities, deliberately small:
 *   1. expose the deterministic audit engine as one model-facing tool;
 *   2. expose the same report to the sidebar panel over one exact `/api` route;
 *   3. keep a short-lived cache so a panel refresh does not re-hash a 96 GB tree.
 *
 * The engine does the work and is read-only: nothing here moves, deletes, or
 * writes a file inside the audited tree. The fix plan is text.
 *
 * @module dsh-layout-governor
 */
import path from 'node:path'
import { audit, buildFixPlan, formatReport } from './engine/index.js'

/** Loader row name; the client factory uses the same id. */
export const name = 'layout-governor'

/** Services required before {@link apply} runs. */
export const inject = ['tools']

/** Model-facing tool name. */
const TOOL_NAME = 'layout_audit'

/** Upper bound for the rendered report handed back to the model, in characters. */
const MAX_TEXT = 16000

/** Default cache lifetime for one root/policy pair. */
const DEFAULT_CACHE_MS = 30_000

/** Rendered form accepted by the tool's `format` parameter. */
const FORMATS = ['markdown', 'text', 'json']

/**
 * Read one optional configuration value with the expected primitive type.
 * @param config - the patch row's raw config object.
 * @param key - field name.
 * @param type - expected `typeof` result.
 * @returns the value, or `undefined` when absent or of the wrong type.
 */
function field(config, key, type) {
  const value = config?.[key]
  return typeof value === type ? value : undefined
}

/**
 * Resolve the tree to audit.
 *
 * Order: the caller's explicit request, the row config, the session's default
 * working directory, then the process directory.
 * @param ctx - registrant context.
 * @param config - patch row config.
 * @param requested - caller-supplied root, if any.
 * @returns an absolute path.
 */
function resolveRoot(ctx, config, requested) {
  if (typeof requested === 'string' && requested.trim() !== '') return path.resolve(requested)
  const configured = field(config, 'root', 'string')
  if (configured !== undefined && configured.trim() !== '') return path.resolve(configured)
  try {
    const workingDirectory = ctx.get('workingDirectory')
    const fallback = workingDirectory?.defaultDirectory
    if (typeof fallback === 'string' && fallback !== '') return path.resolve(fallback)
  } catch {
    // The service is optional; the process directory is a valid last resort.
  }
  return process.cwd()
}

/**
 * Trim a rendered report to the model-facing budget without cutting a line in half.
 * @param text - rendered report.
 * @returns the text, possibly truncated with an explicit marker.
 */
function budget(text) {
  if (text.length <= MAX_TEXT) return text
  const cut = text.slice(0, MAX_TEXT)
  const at = cut.lastIndexOf('\n')
  return `${at > 0 ? cut.slice(0, at) : cut}\n… report truncated (${text.length} chars); narrow it with \`rule\` or re-run the CLI.`
}

/**
 * Build the small, schema-stable value the tool returns. The full report stays
 * on the panel route; the model gets counts, findings and the rendered text.
 * @param report - engine report.
 * @param text - rendered report.
 * @returns the tool value.
 */
function toToolValue(report, text) {
  return {
    ok: true,
    overall: report.overall,
    counts: {
      fail: report.counts.fail,
      warn: report.counts.warn,
      info: report.counts.info,
    },
    findings: report.findings.map((finding) => ({
      id: finding.id,
      rule: finding.rule,
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail,
      ...(finding.paths.length > 0 ? { paths: finding.paths.slice(0, 8) } : {}),
    })),
    text,
  }
}

/**
 * Register the audit tool and the panel route.
 * @param ctx - registrant context carrying the `tools` service.
 * @param config - patch row config (`root`, `policy`, `registry`, `maxEntries`, `cacheMs`).
 * @returns when both registrations are in place.
 */
export function apply(ctx, config = {}) {
  const cacheMs = (() => {
    const value = field(config, 'cacheMs', 'number')
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_CACHE_MS
  })()

  /** @type {Map<string, { at: number, report: import('./engine/index.js').Report }>} */
  const cache = new Map()
  /** @type {Map<string, Promise<unknown>>} */
  const inflight = new Map()

  /**
   * Run one audit, deduplicating concurrent identical scans and honouring the cache.
   * @param root - absolute tree root.
   * @param options - rule filter, signal, cache bypass.
   * @returns the report.
   */
  const runAudit = async (root, options) => {
    const key = `${root}\u0000${String(options.onlyRules ?? '')}\u0000${options.policyPath ?? ''}`
    const now = Date.now()
    if (options.force !== true) {
      const cached = cache.get(key)
      if (cached !== undefined && now - cached.at < cacheMs) return cached.report
      const running = inflight.get(key)
      if (running !== undefined) return running
    }
    const policyPath = options.policyPath ?? field(config, 'policy', 'string')
    const registryPath = options.registryPath ?? field(config, 'registry', 'string')
    const limits = {
      ...(field(config, 'maxEntries', 'number') !== undefined
        ? { maxEntries: field(config, 'maxEntries', 'number') }
        : {}),
      ...(field(config, 'maxDepth', 'number') !== undefined
        ? { maxDepth: field(config, 'maxDepth', 'number') }
        : {}),
      ...(field(config, 'hashConcurrency', 'number') !== undefined
        ? { hashConcurrency: field(config, 'hashConcurrency', 'number') }
        : {}),
      // One knob bounds both the directory walk and the hashing pool: on a slow
      // network mount the walk dominates, and 16 measured ~14x over serial.
      ...(field(config, 'walkConcurrency', 'number') !== undefined
        ? { walkConcurrency: field(config, 'walkConcurrency', 'number') }
        : {}),
    }
    const task = audit({
      root,
      ...(policyPath !== undefined ? { policyPath: path.resolve(policyPath) } : {}),
      ...(registryPath !== undefined ? { registryPath: path.resolve(registryPath) } : {}),
      ...(options.onlyRules !== undefined ? { onlyRules: options.onlyRules } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(Object.keys(limits).length > 0 ? { limits } : {}),
    }).then((report) => {
      cache.set(key, { at: Date.now(), report })
      if (cache.size > 8) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (oldest !== undefined) cache.delete(oldest[0])
      }
      return report
    })
    inflight.set(key, task)
    try {
      return await task
    } finally {
      inflight.delete(key)
    }
  }

  ctx.tools.register({
    name: TOOL_NAME,
    description:
      'Audit a directory tree against its layout policy and report violations: duplicate payloads ' +
      '(same size and hash), backups outside the archive root, large files missing from the registry, ' +
      'README entries that do not exist (or directories the README never mentions), unregistered ' +
      'version families such as several ISOs of one image, and missing protected assets. ' +
      'It is strictly read-only and never moves, deletes, renames or writes anything: it returns ' +
      'findings plus, with `fixPlan`, a shell script you must review instead of running blindly. ' +
      'Use it before reorganizing, deduplicating or deleting files in a workspace, when asked why a ' +
      'directory drifted, or right after writing artifacts that may duplicate existing ones. ' +
      'Root defaults to the session working directory and the policy to <root>/layout.policy.yml.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        root: {
          type: 'string',
          description: 'Absolute or relative directory to audit. Defaults to the session working directory.',
        },
        rule: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['top-level', 'backups', 'duplicates', 'families', 'large-files', 'docs', 'protected'],
          },
          description: 'Restrict the audit to these rule ids. Omit to run every rule the policy enables.',
        },
        fixPlan: {
          type: 'boolean',
          description: 'Append a dry-run fix plan (markdown plus a shell script) for the findings. Nothing is executed.',
        },
        format: {
          type: 'string',
          enum: FORMATS,
          description: 'Rendered form of `text`. Defaults to markdown.',
        },
        force: {
          type: 'boolean',
          description: 'Bypass the short-lived report cache and scan immediately.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'overall', 'counts', 'findings', 'text'],
        properties: {
          ok: { type: 'boolean' },
          overall: { type: 'string', enum: ['fail', 'warn', 'pass'] },
          counts: {
            type: 'object',
            additionalProperties: false,
            required: ['fail', 'warn', 'info'],
            properties: {
              fail: { type: 'integer' },
              warn: { type: 'integer' },
              info: { type: 'integer' },
            },
          },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'rule', 'severity', 'title'],
              properties: {
                id: { type: 'string' },
                rule: { type: 'string' },
                severity: { type: 'string', enum: ['fail', 'warn', 'info'] },
                title: { type: 'string' },
                detail: { type: 'string' },
                paths: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 300_000,
    async execute(args, exec) {
      const root = resolveRoot(ctx, config, args?.root)
      const onlyRules = Array.isArray(args?.rule) && args.rule.length > 0 ? args.rule : undefined
      const format = FORMATS.includes(args?.format) ? args.format : 'markdown'
      const report = await runAudit(root, {
        onlyRules,
        force: args?.force === true,
        signal: exec?.signal,
      })
      let text = formatReport(report, format)
      if (args?.fixPlan === true) {
        const plan = buildFixPlan(report)
        text = `${text}\n\n${plan.markdown}\n\n\`\`\`bash\n${plan.script}\n\`\`\`\n`
      }
      return toToolValue(report, budget(text))
    },
  })

  ctx.inject(['connection'], (scoped) => {
    const connection = scoped.get('connection')
    if (connection === undefined || typeof connection.fetch?.register !== 'function') return
    scoped.effect(
      () =>
        connection.fetch.register({
          path: '/api/layout-governor/report',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            const json = (value, status = 200) =>
              Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
            let body = {}
            try {
              body = await request.json()
            } catch {
              body = {}
            }
            const requestedRoot = typeof body?.root === 'string' ? body.root : undefined
            const root = resolveRoot(ctx, config, requestedRoot)
            try {
              const report = await runAudit(root, {
                force: body?.force === true,
                signal: AbortSignal.timeout(600_000),
              })
              return json({
                ok: true,
                value: {
                  ...report,
                  fixPlan: buildFixPlan(report),
                },
              })
            } catch (error) {
              return json({
                ok: false,
                error: {
                  code: 'layout-governor/scan-failed',
                  message: error instanceof Error ? error.message : String(error),
                },
              })
            }
          },
        }),
      'layout-governor: report route',
    )
  })
}
