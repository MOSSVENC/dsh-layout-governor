#!/usr/bin/env node
/**
 * Mechanical code review.
 *
 * Everything here is a rule a reviewer would otherwise have to remember: the
 * package parses, no file became a dump, the bundle never imports the harness it
 * runs inside, statements end the same way everywhere, and every rule module keeps
 * the shape the registry needs. It is deliberately deterministic — no formatting
 * opinions that need a parser, no dependency install.
 *
 * `node scripts/check-code.mjs` → exit 0 on success, 1 on any violation.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const RUNTIME_DIRS = ['lib', 'bin'];
const ALL_DIRS = ['lib', 'bin', 'test', 'fixtures', 'scripts'];

/** Runtime files larger than this are a design smell, not a style preference. */
const RUNTIME_LINE_BUDGET = 600;

/**
 * A client bundle cannot import its own modules: the Web loader hands it
 * `require('react')` and nothing else, so the panel is one file by construction.
 * It gets its own budget rather than an exemption from the check.
 */
const BUNDLE_LINE_BUDGET = { 'lib/client.js': 700 };

/** Files allowed to print: the CLI owns stdout. */
const CONSOLE_ALLOWED = new Set(['bin/layout-governor.mjs', 'scripts/check-code.mjs']);

const violations = [];

/**
 * Record a violation.
 * @param {string} file Relative path.
 * @param {string} message Human-readable problem.
 */
function fail(file, message) {
  violations.push(`${file}: ${message}`);
}

/**
 * Every JavaScript file below a directory, recursively.
 * @param {string} dir Absolute or relative directory.
 * @returns {Promise<string[]>} Paths relative to the package root.
 */
async function collect(dir) {
  const absolute = path.join(ROOT, dir);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(rel)));
    else if (/\.(js|mjs)$/.test(entry.name)) files.push(rel);
  }
  return files;
}

/**
 * Parse one module with Node's own checker.
 * @param {string} rel Relative path.
 * @returns {boolean} Whether it parsed.
 */
function parses(rel) {
  const result = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail(rel, `does not parse: ${(result.stderr || '').trim().split('\n').slice(0, 2).join(' ')}`);
    return false;
  }
  return true;
}

const files = [];
for (const dir of ALL_DIRS) files.push(...(await collect(dir)));

for (const rel of files) {
  const source = await readFile(path.join(ROOT, rel), 'utf8');
  const lines = source.split('\n');
  const runtime = RUNTIME_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}/`));

  parses(rel);

  const budget = BUNDLE_LINE_BUDGET[rel] ?? RUNTIME_LINE_BUDGET;
  if (runtime && lines.length > budget) {
    fail(rel, `${lines.length} lines exceeds the ${budget}-line runtime budget`);
  }
  if (!source.endsWith('\n')) fail(rel, 'missing trailing newline');
  if (source.endsWith('\n\n')) fail(rel, 'ends with a blank line');
  if (source.includes('\r')) fail(rel, 'contains CRLF line endings');
  if (source.includes('\t')) fail(rel, 'contains a tab; the package is space-indented');
  // Markers only count inside comments; the strings may legitimately appear in
  // the checker itself, which lives outside `lib`, `bin`, and `test`.
  if (rel !== 'scripts/check-code.mjs') {
    for (const marker of ['TODO', 'FIXME', 'XXX']) {
      const commentUse = new RegExp(`(//|/\\*|\\*)\\s*${marker}\\b`);
      if (commentUse.test(source)) fail(rel, `contains a ${marker} marker`);
    }
  }
  if (runtime && !CONSOLE_ALLOWED.has(rel) && /console\.(log|debug|info|warn|error)/.test(source)) {
    fail(rel, 'prints to the console; only the CLI may write to stdout');
  }
  if (runtime && /from '@deepseek-ai\//.test(source)) {
    fail(rel, 'imports a harness package; the bundle must resolve entirely on its own');
  }

  // One statement style: a single-line statement must end with a semicolon.
  // Multi-line constructs are recognised by an unbalanced bracket, a template
  // literal left open, a trailing operator, or a continuation line, and skipped —
  // the rule is about style, not about parsing JavaScript with a regex.
  let inTemplate = false;
  lines.forEach((line, index) => {
    const opensTemplate = (line.match(/(?<!\\)`/g) ?? []).length % 2 === 1;
    const wasInTemplate = inTemplate;
    if (opensTemplate) inTemplate = !inTemplate;
    // A line that opens a template literal is continued by definition.
    if (wasInTemplate || opensTemplate) return;
    if (!/^\s*(const|let|return|throw|import|export default)\b/.test(line)) return;
    const trimmed = line.trimEnd();
    if (trimmed.endsWith(';')) return;
    if (/[([{,]$/.test(trimmed)) return;
    if (/(=>|=|&&|\|\||[+\-*/?:.])$/.test(trimmed)) return;
    const delta = (line.match(/[([{]/g) ?? []).length - (line.match(/[)\]}]/g) ?? []).length;
    if (delta > 0) return;
    const next = (lines[index + 1] ?? '').trimStart();
    // `}` is deliberately absent: it usually closes the block after a complete
    // statement, and treating it as a continuation hid the missing semicolon this
    // check exists to find.
    if (next !== '' && /^([.)\]?:]|&&|\|\||[+*]|\.)/.test(next)) return;
    fail(rel, `line ${index + 1} starts a statement but does not end with ";": ${trimmed.trim().slice(0, 60)}`);
  });
}

// Each rule module keeps the registry's contract.
const ruleDir = path.join(ROOT, 'lib', 'engine', 'rules');
const ruleFiles = (await readdir(ruleDir)).filter((name) => name.endsWith('.js')).sort();
const registry = await readFile(path.join(ROOT, 'lib', 'engine', 'index.js'), 'utf8');
for (const name of ruleFiles) {
  const rel = path.posix.join('lib/engine/rules', name);
  const source = await readFile(path.join(ruleDir, name), 'utf8');
  for (const required of ['export const id', 'export const defaults', 'export async function run']) {
    if (!source.includes(required)) fail(rel, `rule module is missing \`${required}\``);
  }
  const id = /export const id = '([^']+)'/.exec(source)?.[1];
  if (id === undefined) {
    fail(rel, 'rule id is not a literal string');
  } else if (name !== `${id}.js`) {
    fail(rel, `file name does not match rule id "${id}"`);
  } else if (!registry.includes(`rule${id.replace(/(^|-)(\w)/g, (_, __, chr) => chr.toUpperCase())}`)) {
    // The registry imports each module under a camelCase alias; a rule that is not
    // registered silently never runs, which is worse than a failing build.
    const imported = new RegExp(`from '\\./rules/${id}\\.js'`).test(registry);
    if (!imported) fail(rel, 'rule module is not imported by lib/engine/index.js');
  }
}

if (violations.length > 0) {
  process.stderr.write(`check-code: ${violations.length} problem(s)\n`);
  for (const item of violations) process.stderr.write(`  - ${item}\n`);
  process.exit(1);
}

process.stdout.write(`check-code: ${files.length} files, ${ruleFiles.length} rules, clean\n`);
