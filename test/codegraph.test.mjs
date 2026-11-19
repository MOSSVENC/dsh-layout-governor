/**
 * The code graph answers two questions honestly: where is it defined, and what
 * does this file depend on. Everything else it refuses to claim.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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

test('M1: dependents resolves the file a relative import points at', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-dep-'));
  created.push(dir);
  const root = path.join(dir, 'tree');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'helper.js'), 'function helper() {}\n');
  await writeFile(path.join(root, 'src', 'user.js'), "import './helper.js'\n");
  await writeFile(path.join(root, 'layout.policy.yml'), 'version: 1\nrules: {}\n');
  const store = path.join(dir, 'layout.db');
  await audit({ root, storePath: store });

  // The question an agent actually asks: by file name, not by the literal import string.
  const byName = codeQuery({ storePath: store, mode: 'dependents', filters: { target: 'helper.js' } });
  assert.equal(byName.rows.length, 1, 'a bare file name finds the importer');
  assert.match(byName.rows[0].path, /user\.js/);

  const byTarget = codeQuery({ storePath: store, mode: 'dependents', filters: { target: './helper.js' } });
  assert.equal(byTarget.rows.length, 1, 'the literal target still works');
});

test('M2: a corrupt index is quarantined and rebuilt, not fatal', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-corrupt-'));
  created.push(dir);
  const root = path.join(dir, 'tree');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'layout.policy.yml'), 'version: 1\nrules: {}\n');
  const store = path.join(dir, 'layout.db');

  await writeFile(store, Buffer.from('this is not a sqlite database at all'));
  const report = await audit({ root, storePath: store });
  assert.equal(report.index?.error, undefined, 'the audit survives a corrupt index');
  assert.ok(report.index?.files >= 0);

  const quarantined = await readdir(dir);
  assert.ok(
    quarantined.some((name) => name.includes('.corrupt-')),
    'the corrupt file is moved aside, not deleted',
  );
});

test('M2: a foreign sqlite database is refused, not written into', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-foreign-'));
  created.push(dir);
  const root = path.join(dir, 'tree');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'layout.policy.yml'), 'version: 1\nrules: {}\n');
  const store = path.join(dir, 'other.db');
  const { DatabaseSync } = await import('node:sqlite');
  const foreign = new DatabaseSync(store);
  foreign.exec('CREATE TABLE someone_elses (id INTEGER PRIMARY KEY)');
  foreign.close();

  const report = await audit({ root, storePath: store });
  assert.match(String(report.index?.error ?? ''), /did not create/i);
  const tables = new DatabaseSync(store);
  const names = tables.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  assert.deepEqual(names.map((row) => row.name), ['someone_elses'], 'no tables were added');
  tables.close();
});

test('M3: run history is pruned instead of growing forever', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-prune-'));
  created.push(dir);
  const root = path.join(dir, 'tree');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'layout.policy.yml'), 'version: 1\nrules: {}\n');
  const store = path.join(dir, 'layout.db');

  for (let index = 0; index < 6; index += 1) {
    await audit({ root, storePath: store, limits: { maxRuns: 2 } });
  }
  const report = await audit({ root, storePath: store, limits: { maxRuns: 2 } });
  assert.ok(report.index.runs <= 2, `history kept ${report.index.runs} runs`);
});

test('V1b: an index missing whole tables is repaired, not merely column-patched', async () => {
  // The real failure: the workspace shipped a schema=1 index written before the
  // code tables existed. Migration ran before CREATE, so ALTER TABLE imports died
  // with "no such table: imports" and every query failed from then on.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-legacy-'));
  created.push(dir);
  const root = path.join(dir, 'tree');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.js'), 'function alpha() {}\n');
  await writeFile(path.join(root, 'layout.policy.yml'), 'version: 1\nrules: {}\n');
  const store = path.join(dir, 'old.db');

  const { DatabaseSync } = await import('node:sqlite');
  const legacy = new DatabaseSync(store);
  legacy.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  legacy.exec("INSERT INTO meta VALUES ('schema','1')");
  legacy.exec(
    'CREATE TABLE files (path TEXT PRIMARY KEY, kind TEXT NOT NULL, size INTEGER NOT NULL, ' +
      'mtime INTEGER NOT NULL, hash TEXT, hash_mode TEXT, class TEXT, ' +
      'protected INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)',
  );
  legacy.close();

  const report = await audit({ root, storePath: store });
  assert.equal(report.index?.error, undefined, 'the index is repaired rather than failing');
  assert.ok(report.index.symbols >= 1, 'the symbol table now exists and is filled');

  const repaired = new DatabaseSync(store);
  assert.equal(repaired.prepare("SELECT value FROM meta WHERE key='schema'").get().value, '2');
  const tables = repaired
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name);
  for (const required of ['files', 'imports', 'symbols', 'code_files', 'runs', 'findings']) {
    assert.ok(tables.includes(required), `${required} was created`);
  }
  repaired.close();
});
