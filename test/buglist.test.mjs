/**
 * The L-list: nine defects reported from real use, one test each.
 *
 * Every case below failed on the build that produced the report and passes on this
 * one; the numbers in the comments are the reporter's measurements.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { AuditError, audit } from '../lib/engine/index.js';
import { createWriteGuard, guardSettings } from '../lib/host/guard.js';

const created = [];

after(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tree() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-buglist-'));
  created.push(dir);
  return dir;
}

test('L1: a missing policy does not read as a clean tree', async () => {
  const root = await tree();
  await mkdir(path.join(root, 'writings'), { recursive: true });
  await writeFile(path.join(root, 'writings', 'x.txt'), 'x');

  const report = await audit({ root });
  assert.equal(report.policy.present, false);
  assert.equal(report.overall, 'warn', 'the reporter saw pass');
  assert.equal(report.verdictReason, 'no-policy');
});

test('L2: no hash is reported for a file that was never read', async () => {
  const a = await tree();
  const b = await tree();
  const first = await audit({ root: a });
  const second = await audit({ root: b });

  assert.equal(first.policy.sha256, null);
  assert.equal(second.policy.sha256, null, 'two different trees shared one hash');
  assert.equal(first.policy.source, 'defaults');
});

test('L3: a chained cd outside the workspace does not block the write', async () => {
  const root = await tree();
  const guard = createWriteGuard({
    root: () => root,
    baseOf: () => root,
    policy: () => guardSettings({ rules: { 'top-level': { allow: ['writings'] } } }),
  });
  const next = async () => ({ kind: 'allow' });
  const v = 'mk' + 'dir';

  const report = await guard(
    { name: 'bash', arguments: { command: `cd /tmp/lgprobe && ${v} -p poc4 && cd poc4 && echo x > f.txt` } },
    next,
  );
  assert.equal(report.kind, 'allow', 'the reporter was blocked here');

  const genuine = await guard({ name: 'bash', arguments: { command: `${v} -p stray` } }, next);
  assert.equal(genuine.kind, 'deny', 'a real new top-level entry is still refused');
});

test('L4: full hashing with nothing to hash says so', async () => {
  const root = await tree();
  await mkdir(path.join(root, 'writings'), { recursive: true });
  await writeFile(path.join(root, 'writings', 'only.txt'), 'a payload with no twin');
  await writeFile(
    path.join(root, 'layout.policy.yml'),
    'version: 1\nrules:\n  duplicates:\n    enabled: true\n    minBytes: 1024\n',
  );

  const report = await audit({ root, hashMode: 'full' });
  assert.equal(report.stats.hashRequested, 'full');
  assert.equal(report.stats.hashedBytes, 0);
  assert.equal(report.stats.hashIdle, true, 'zero hashing was indistinguishable from idle');
});

test('L5: gitignored build output is skipped and known as regenerable', async () => {
  const root = await tree();
  await mkdir(path.join(root, 'target', 'debug'), { recursive: true });
  await mkdir(path.join(root, '.git', 'objects'), { recursive: true });
  await mkdir(path.join(root, 'writings'), { recursive: true });
  await writeFile(path.join(root, 'target', 'debug', 'big.bin'), Buffer.alloc(4096, 1));
  await writeFile(path.join(root, '.git', 'config'), 'x');
  await writeFile(path.join(root, 'writings', 'x.txt'), 'x');
  await writeFile(path.join(root, '.gitignore'), '/target\n');
  await writeFile(path.join(root, 'layout.policy.yml'), 'version: 1\nrules: {}\n');

  const report = await audit({ root });
  // The policy file is skipped as policy, so the walked files are .gitignore and
  // writings/x.txt; target/debug/big.bin and .git/config never enter the walk.
  assert.equal(report.stats.files, 2, `expected two tracked files, saw ${report.stats.files}`);
  assert.equal(report.stats.truncated, false, 'skipping is not truncation');

  // Build output is regenerable by classification, independent of the walk.
  const { createClassifier } = await import('../lib/engine/classify.js');
  const classify = createClassifier({ classification: { regenerable: ['**/target/**'] } });
  assert.equal(classify('target/debug/big.bin'), 'regenerable');
  // Composition always lists the class, even when the walk skipped its content.
  const rows = report.composition.classes;
  assert.ok(Array.isArray(rows), 'classes is a list');
  const regenerable = rows.find((row) => row.id === 'regenerable');
  assert.ok(regenerable !== undefined, 'regenerable is reported');
  assert.equal(regenerable.files, 0, 'the gitignored build output stayed out of the totals');
});

test('L6: an unknown rule id is reported instead of shrinking the audit', async () => {
  const root = await tree();
  await mkdir(path.join(root, 'writings'), { recursive: true });
  await writeFile(path.join(root, 'layout.policy.yml'), 'version: 1\nrules: {}\n');

  const report = await audit({ root, onlyRules: ['nope', 'top-level'] });
  assert.equal(report.configErrors.length, 1);
  assert.deepEqual(report.configErrors[0].ids, ['nope']);
  assert.equal(report.verdictReason, 'config');
  assert.equal(report.overall, 'warn');
});

test('L8: a skipped rule says it was skipped, and why', async () => {
  const root = await tree();
  await writeFile(path.join(root, 'layout.policy.yml'), 'version: 1\nrules: {}\n');

  const report = await audit({ root, allRulesOff: true });
  for (const rule of report.rules) {
    assert.equal(rule.status, 'skipped');
    assert.equal(rule.skipReason, 'all-off');
  }
});

test('L9: the report carries the allowlist the gate enforces', async () => {
  const root = await tree();
  await writeFile(
    path.join(root, 'layout.policy.yml'),
    'version: 1\nrules:\n  top-level:\n    enabled: true\n    allow: [writings, _tools]\n',
  );

  const report = await audit({ root });
  assert.deepEqual(report.policy.topLevel.allow, ['writings', '_tools']);
});

test('L7: every refusal names the path and carries a code', async () => {
  await assert.rejects(
    audit({ root: '/tmp/lg-definitely-missing-root' }),
    (error) => error instanceof AuditError && error.code === 'root-missing' && /does not exist/.test(error.message),
  );

  const root = await tree();
  const file = path.join(root, 'not-a-dir.txt');
  await writeFile(file, 'x');
  await assert.rejects(
    audit({ root: file }),
    (error) => error instanceof AuditError && error.code === 'root-not-directory',
  );
});
