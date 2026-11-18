/**
 * The model-facing surface: one tool, `layout_audit`.
 *
 * The tool description is the only instruction the model receives from this
 * plugin — there is no system-prompt section, no injected text, and nothing that
 * changes the agent's behaviour outside this call. It says what the audit covers,
 * that it is read-only, and that a returned fix plan must be reviewed rather than
 * run.
 */

import { RULES, buildFixPlan, formatReport } from '../engine/index.js';

/** Model-facing tool name. */
export const TOOL_NAME = 'layout_audit';

/** Rendered forms the tool accepts. */
export const FORMATS = ['markdown', 'text', 'json'];

/** Rule ids offered as the tool's enum, derived so a new rule cannot be advertised stale. */
export const RULE_IDS = RULES.map((rule) => rule.id);

/** Upper bound for the rendered report handed back to the model, in characters. */
export const MAX_TEXT = 16_000;

/** Cooperative timeout for one audit, generous enough for a cold 100k-entry walk. */
const TIMEOUT_MS = 300_000;

const DESCRIPTION =
  'Audit a directory tree against its layout policy and report violations: duplicate payloads ' +
  '(same size and hash), backups outside the archive root, large files missing from the registry, ' +
  'README entries that do not exist (or directories the README never mentions), unregistered ' +
  'version families such as several ISOs of one image, and missing protected assets. ' +
  'It is strictly read-only and never moves, deletes, renames or writes anything: it returns ' +
  'findings plus, with `fixPlan`, a shell script you must review instead of running blindly. ' +
  'Use it before reorganizing, deduplicating or deleting files in a workspace, when asked why a ' +
  'directory drifted, or right after writing artifacts that may duplicate existing ones. ' +
  'Root defaults to the session working directory and the policy to <root>/layout.policy.yml.';

/**
 * Trim a rendered report to the model-facing budget without cutting a line in half.
 * @param {string} text Rendered report.
 * @param {number} [max] Character budget.
 * @returns {string} The text, possibly truncated with an explicit marker.
 */
export function budgetText(text, max = MAX_TEXT) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf('\n');
  const kept = at > 0 ? cut.slice(0, at) : cut;
  return `${kept}\n… report truncated (${text.length} chars); narrow it with \`rule\` or re-run the CLI.`;
}

/**
 * Build the small, schema-stable value the tool returns.
 *
 * The full report stays on the panel route; the model gets counts, findings, and
 * the rendered text, which is what it can act on without paying for every path.
 *
 * @param {object} report Engine report.
 * @param {string} text Rendered report.
 * @returns {object} Tool value matching the declared output schema.
 */
export function toToolValue(report, text) {
  return {
    ok: true,
    overall: report.overall,
    counts: { fail: report.counts.fail, warn: report.counts.warn, info: report.counts.info },
    findings: report.findings.map((finding) => ({
      id: finding.id,
      rule: finding.rule,
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail,
      ...(finding.paths.length > 0 ? { paths: finding.paths.slice(0, 8) } : {}),
    })),
    text,
  };
}

/**
 * Render the report in the requested form and append the optional fix plan.
 * @param {object} report Engine report.
 * @param {{ format?: string, fixPlan?: boolean }} args Tool arguments.
 * @returns {string} Model-facing text.
 */
function renderForModel(report, args) {
  const format = FORMATS.includes(args?.format) ? args.format : 'markdown';
  let text = formatReport(report, format);
  if (args?.fixPlan === true) {
    const plan = buildFixPlan(report);
    text = `${text}\n\n${plan.markdown}\n\n\`\`\`bash\n${plan.script}\n\`\`\`\n`;
  }
  return budgetText(text);
}

/**
 * Create the tool definition.
 * @param {object} deps
 * @param {(root: string, options: object) => Promise<object>} deps.runAudit Cached audit runner.
 * @param {(requested: unknown, session?: unknown) => string} deps.resolveRoot Root resolver.
 * @returns {object} A registry-ready tool definition.
 */
export function createAuditTool({ runAudit, resolveRoot }) {
  return {
    name: TOOL_NAME,
    description: DESCRIPTION,
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
          items: { type: 'string', enum: RULE_IDS },
          description: 'Restrict the audit to these rule ids. Omit to run every rule the policy enables.',
        },
        fixPlan: {
          type: 'boolean',
          description:
            'Append a dry-run fix plan (markdown plus a shell script) for the findings. Nothing is executed.',
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
    timeoutMs: TIMEOUT_MS,
    async execute(args, exec) {
      // The agent's session decides the default tree, not the host's cwd.
      const root = resolveRoot(args?.root, exec?.agent?.session);
      const onlyRules = Array.isArray(args?.rule) && args.rule.length > 0 ? args.rule : undefined;
      const report = await runAudit(root, {
        onlyRules,
        force: args?.force === true,
        signal: exec?.signal,
      });
      return toToolValue(report, renderForModel(report, args));
    },
  };
}
