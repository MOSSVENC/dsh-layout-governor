#!/usr/bin/env node
/**
 * layout-governor — command line front end.
 *
 * Exit codes: 0 ok, 1 `--check` found a `fail`, 2 usage or engine error.
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

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);

    const take = () => {
      if (inlineValue !== undefined) return inlineValue;
      i += 1;
      if (i >= argv.length) throw new UsageError(`missing value for ${flag}`);
      return argv[i];
    };

    switch (flag) {
      case '--root':
        options.root = take();
        break;
      case '--policy':
        options.policy = take();
        break;
      case '--registry':
        options.registry = take();
        break;
      case '--format': {
        const value = take();
        const format = FORMATS.get(String(value).toLowerCase());
        if (!format) throw new UsageError(`unknown --format: ${value}`);
        options.format = format;
        break;
      }
      case '--rule': {
        const value = take();
        for (const id of String(value).split(',').map((part) => part.trim())) {
          if (id !== '') options.rules.push(id);
        }
        break;
      }
      case '--limit': {
        const value = Number(take());
        if (!Number.isFinite(value) || value <= 0) throw new UsageError('--limit must be a positive number');
        options.limit = Math.floor(value);
        break;
      }
      case '--concurrency': {
        const value = Number(take());
        if (!Number.isFinite(value) || value <= 0) {
          throw new UsageError('--concurrency must be a positive number');
        }
        options.concurrency = Math.floor(value);
        break;
      }
      case '--jobs': {
        const value = Number(take());
        if (!Number.isFinite(value) || value <= 0) throw new UsageError('--jobs must be a positive number');
        options.jobs = Math.floor(value);
        break;
      }
      case '--all-off':
        options.allOff = true;
        break;
      case '--fix-plan':
        options.fixPlan = true;
        break;
      case '--check':
        options.check = true;
        break;
      case '--version':
        options.version = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        if (flag.startsWith('-')) throw new UsageError(`unknown option: ${flag}`);
        throw new UsageError(`unexpected argument: ${arg}`);
    }
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

  if (options.check && report.overall === 'fail') return 1;
  return 0;
}

const code = await main(process.argv.slice(2));
process.exitCode = code;
