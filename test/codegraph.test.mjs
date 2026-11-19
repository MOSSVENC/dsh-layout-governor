/**
 * The code graph answers two questions honestly: where is it defined, and what
 * does this file depend on. Everything else it refuses to claim.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { codeQuery, audit } from '../lib/engine/index.js';
import { extract, languageOf } from '../lib/engine/codegraph.js';

const created = [];

after(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

test('symbols and imports per language', () => {
  const cases = {
    javascript: [
      "import x from './a.js'",
      'export function alpha(a) {}',
      'class Gamma {}',
      'const delta = async (q) => q',
    ],
    python: ['from pathlib import Path', 'def foo(a):', 'class Baz:'],
    gdscript: ['extends Node2D', 'func _ready():', 'signal hit'],
    c: ['#include "util.h"', 'int add(int a, int b) {'],
    rust: ['use std::io;', 'pub fn run() {}', 'pub struct Point {'],
    go: ['import "fmt"', 'func handler(w Writer) {}', 'type Route struct {'],
  };
  for (const [lang, lines] of Object.entries(cases)) {
    const { symbols, imports } = extract(`${lines.join('\n')}\n`, lang);
    assert.ok(symbols.length > 0, `${lang} produced symbols`);
    assert.ok(imports.length > 0, `${lang} produced imports`);
  }
});

test('vendored and oversized files are out of scope', () => {
  assert.equal(languageOf('_projects/x/.venv/lib/a.py', '.py', 100), null);
  assert.equal(languageOf('web/node_modules/left.js', '.js', 100), null);
  assert.equal(languageOf('a.js', '.js', 3 * 1024 * 1024), null);
  assert.equal(languageOf('src/a.py', '.py', 100), 'python');
});

test('the index answers where a symbol is defined and what a file imports', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-code-'));
  created.push(dir);
  const root = path.join(dir, 'tree');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(
    path.join(root, 'src', 'lib.js'),
    "const helper = (x) => x\nexport function runAudit(options) {}\n",
  );
  await writeFile(
    path.join(root, 'src', 'main.js'),
    "import { runAudit } from './lib.js'\nfunction main() { runAudit({}) }\n",
  );
  await writeFile(path.join(root, 'layout.policy.yml'), 'version: 1\nrules: {}\n');
  const store = path.join(dir, 'layout.db');

  const report = await audit({ root, storePath: store });
  assert.ok(report.index.codeParsed >= 2);
  assert.ok(report.index.symbols >= 3, 'symbols land in the index');

  const definition = codeQuery({ storePath: store, mode: 'symbol', filters: { name: 'runAudit' } });
  assert.equal(definition.rows.length, 1, 'one definition; a call site is not a definition');
  assert.ok(definition.rows[0].path.endsWith('lib.js'));
  assert.equal(definition.rows[0].kind, 'function');

  const imports = codeQuery({ storePath: store, mode: 'imports', filters: { path: 'main.js' } });
  assert.equal(imports.rows.length, 1);
  assert.equal(imports.rows[0].target, './lib.js');

  const dependents = codeQuery({ storePath: store, mode: 'dependents', filters: { target: './lib.js' } });
  assert.equal(dependents.rows.length, 1, 'who imports it — the question before deleting it');
  assert.match(dependents.rows[0].path, /main\.js/);
});

test('unchanged files are not re-parsed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-code2-'));
  created.push(dir);
  const root = path.join(dir, 'tree');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.js'), 'function one() {}\n');
  await writeFile(path.join(root, 'layout.policy.yml'), 'version: 1\nrules: {}\n');
  const store = path.join(dir, 'layout.db');

  const first = await audit({ root, storePath: store });
  const second = await audit({ root, storePath: store });
  assert.ok(first.index.codeParsed >= 1);
  assert.equal(second.index.codeParsed, 0, 'the second pass parses nothing');

  await writeFile(path.join(root, 'src', 'a.js'), 'function one() {}\nfunction two() {}\n');
  const third = await audit({ root, storePath: store });
  assert.equal(third.index.codeParsed, 1, 'only the touched file is re-read');
});

test('deleted code leaves the graph', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-code3-'));
  created.push(dir);
  const root = path.join(dir, 'tree');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'gone.js'), 'function vanish() {}\n');
  await writeFile(path.join(root, 'layout.policy.yml'), 'version: 1\nrules: {}\n');
  const store = path.join(dir, 'layout.db');

  await audit({ root, storePath: store });
  assert.equal(codeQuery({ storePath: store, mode: 'symbol', filters: { name: 'vanish' } }).rows.length, 1);

  await rm(path.join(root, 'src', 'gone.js'));
  await audit({ root, storePath: store });
  assert.equal(
    codeQuery({ storePath: store, mode: 'symbol', filters: { name: 'vanish' } }).rows.length,
    0,
    'a query never reports a symbol from a deleted file',
  );
});
