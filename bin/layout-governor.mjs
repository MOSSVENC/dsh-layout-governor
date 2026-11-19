#!/usr/bin/env node
/**
 * layout-governor — command line front end.
 *
 * Exit codes: 0 ok, 1 `--check` found anything other than a clean pass, 2 usage
 * or engine error.
 * Output is plain text with no ANSI colour so it survives pipes and log files.
 */

import path from 'node:path';

import { audit, buildFixPlan, formatReport } from '../lib/engine/index.js';

const USAGE = `usage: layout-governor [--root DIR] [--policy FILE] [--registry FILE]
                       [--format json|text|md] [--fix-plan] [--check]
                       [--rule ID ...] [--all-off] [--limit N]
                       [--concurrency N] [--jobs N]

  --concurrency N  filesystem operations in flight; bounds BOTH directory
                   traversal and large-file hashing. Defaults: walk 16, hash 4.
  --jobs N         large-file hashing only; overrides --concurrency for hashing.
  --limit N        hard cap on walked entries (sets stats.truncated when hit).`;

const FORMATS = new Map([
  ['json', 'json'],
  ['text', 'text'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
]);

/**
 * Raised for bad command lines; mapped to exit code 2.
 */
class UsageError extends Error {}

/**
 * Coerce a value into a positive integer, or reject the command line.
 * @param {string} flag Flag name, for the message.
 * @returns {(raw: string) => number} Parser.
 */
function positive(flag) {
  return (raw) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new UsageError(`${flag} must be a positive number`);
    return Math.floor(value);
  };
}

/**
 * Split a comma-separated list, dropping blanks.
 * @param {string} raw Raw value.
 * @returns {string[]} Values.
 */
function list(raw) {
  return String(raw)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * Map a format name onto the renderer's spelling.
 * @param {string} raw Raw value.
 * @returns {string} Canonical format.
 */
function parseFormat(raw) {
  const format = FORMATS.get(String(raw).toLowerCase());
  if (!format) throw new UsageError(`unknown --format: ${raw}`);
  return format;
}

/**
 * Flag table: adding a flag means adding one row, not another switch branch.
 *
 * `takesValue` is what makes `--flag=value` and `--flag value` behave the same;
 * `append` is for flags that accumulate instead of overwriting.
 */
const FLAGS = new Map([
  ['--root', { key: 'root', takesValue: true }],
  ['--policy', { key: 'policy', takesValue: true }],
  ['--registry', { key: 'registry', takesValue: true }],
  ['--format', { key: 'format', takesValue: true, parse: parseFormat }],
  ['--rule', { key: 'rules', takesValue: true, parse: list, append: true }],
  ['--limit', { key: 'limit', takesValue: true, parse: positive('--limit') }],
  ['--concurrency', { key: 'concurrency', takesValue: true, parse: positive('--concurrency') }],
  ['--jobs', { key: 'jobs', takesValue: true, parse: positive('--jobs') }],
  ['--all-off', { key: 'allOff', takesValue: false, parse: () => true }],
  ['--fix-plan', { key: 'fixPlan', takesValue: false, parse: () => true }],
  ['--check', { key: 'check', takesValue: false, parse: () => true }],
  ['--version', { key: 'version', takesValue: false, parse: () => true }],
  ['-h', { key: 'help', takesValue: false, parse: () => true }],
  ['--help', { key: 'help', takesValue: false, parse: () => true }],
]);

/**
 * Parse the command line.
 * @param {string[]} argv Arguments without the node and script names.
 * @returns {object} Parsed options.
 */
function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    policy: null,
    registry: null,
    format: 'text',
    fixPlan: false,
    check: false,
    rules: [],
    allOff: false,
    limit: null,
    concurrency: null,
    jobs: null,
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const separator = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    const inline = separator === -1 ? undefined : arg.slice(separator + 1);
    const spec = FLAGS.get(flag);
    if (spec === undefined) {
      throw new UsageError(flag.startsWith('-') ? `unknown option: ${flag}` : `unexpected argument: ${arg}`);
    }

    let raw;
    if (spec.takesValue === true) {
      if (inline !== undefined) {
        raw = inline;
      } else {
        index += 1;
        if (index >= argv.length) throw new UsageError(`missing value for ${flag}`);
        raw = argv[index];
      }
    }
    const value = spec.parse === undefined ? raw : spec.parse(raw);
    if (spec.append === true) options[spec.key].push(...(Array.isArray(value) ? value : [value]));
    else options[spec.key] = value ?? true;
  }

  return options;
}

function write(text) {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`layout-governor: ${err.message}\n${USAGE}\n`);
    return 2;
  }

  if (options.help) {
    write(USAGE);
    return 0;
  }

  const root = path.resolve(options.root);
  const auditOptions = { root };
  if (options.policy) auditOptions.policyPath = path.resolve(options.policy);
  if (options.registry) auditOptions.registryPath = path.resolve(options.registry);
  if (options.rules.length > 0) auditOptions.onlyRules = options.rules;
  if (options.allOff) auditOptions.allRulesOff = true;
  const limits = {};
  if (options.limit !== null) limits.maxEntries = options.limit;
  if (options.concurrency !== null) {
    limits.walkConcurrency = options.concurrency;
    limits.hashConcurrency = options.concurrency;
  }
  if (options.jobs !== null) limits.hashConcurrency = options.jobs;
  if (Object.keys(limits).length > 0) auditOptions.limits = limits;

  let report;
  try {
    report = await audit(auditOptions);
  } catch (err) {
    process.stderr.write(`layout-governor: ${err && err.message ? err.message : err}\n`);
    return 2;
  }

  if (options.version) {
    write(`${report.engine} ${report.engineVersion}`);
    return 0;
  }

  if (options.fixPlan) {
    const plan = buildFixPlan(report, {});
    if (options.format === 'json') {
      write(JSON.stringify({ report, fixPlan: plan }, null, 2));
    } else {
      write(formatReport(report, options.format));
      write(plan.markdown);
    }
  } else {
    write(formatReport(report, options.format));
  }

  // A gate that passes `warn` is a gate that passes a partial or dirty tree.
  if (options.check && report.overall !== 'pass') return 1;
  return 0;
}

const code = await main(process.argv.slice(2));
process.exitCode = code;
