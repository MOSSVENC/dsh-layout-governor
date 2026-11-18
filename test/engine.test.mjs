import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildFixture } from '../fixtures/build.mjs';
import { audit, formatReport, RULES } from '../lib/engine/index.js';

async function withFixture(t, name) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-engine-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return buildFixture(name, dir);
}

function auditOpts(fixture) {
  return { root: fixture.root, policyPath: fixture.policyPath, registryPath: fixture.registryPath };
}

test('clean fixture is all green', async (t) => {
  const fixture = await withFixture(t, 'clean');
  const report = await audit(auditOpts(fixture));

  assert.equal(report.overall, 'pass');
  assert.deepEqual(report.counts, { fail: 0, warn: 0, info: 0 });
  assert.deepEqual(report.findings, []);
  assert.equal(report.stats.truncated, false);

  assert.equal(report.engine, 'dsh-layout-governor');
  assert.equal(report.engineVersion, '0.1.0');
  assert.equal(report.root, fixture.root);
  assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(report.policy.path, fixture.policyPath);
  assert.equal(report.policy.present, true);
  assert.equal(report.policy.version, 1);
  assert.match(report.policy.sha256, /^[0-9a-f]{64}$/);
  assert.equal(report.registry.present, true);

  assert.equal(report.rules.length, RULES.length);
  assert.equal(report.rules.length, 7);
  for (const rule of report.rules) {
    assert.equal(rule.enabled, true, `${rule.id} should be enabled`);
    assert.equal(rule.findings, 0, `${rule.id} should be silent`);
    assert.equal(typeof rule.durationMs, 'number');
  }

  assert.equal(report.stats.symlinks, 0);
  assert.ok(report.stats.files >= 10);
  assert.ok(report.stats.bytes > 0);
});

test('clean fixture composition buckets every class', async (t) => {
  const fixture = await withFixture(t, 'clean');
  const report = await audit(auditOpts(fixture));

  const byId = new Map(report.composition.classes.map((item) => [item.id, item]));
  assert.deepEqual([...byId.keys()], ['regenerable', 'backup', 'protected', 'canonical']);
  for (const id of ['regenerable', 'backup', 'protected', 'canonical']) {
    assert.ok(byId.get(id).bytes > 0, `${id} should own bytes in the clean fixture`);
  }
  const regenerable = report.composition.topLevel.find((item) => item.name === '_projects');
  assert.equal(regenerable.class, 'regenerable');
  const archive = report.composition.topLevel.find((item) => item.name === '_archive');
  assert.equal(archive.class, 'backup');
});

const NEGATIVE = [
  ['duplicates', 'duplicates'],
  ['backup-location', 'backups'],
  ['docs-drift', 'docs'],
  ['families', 'families'],
  ['large-files', 'large-files'],
  ['protected-missing', 'protected'],
];

for (const [fixtureName, ruleId] of NEGATIVE) {
  test(`negative fixture ${fixtureName} only trips ${ruleId}`, async (t) => {
    const fixture = await withFixture(t, fixtureName);
    const report = await audit(auditOpts(fixture));

    assert.notEqual(report.overall, 'pass');
    const hitRules = [...new Set(report.findings.map((item) => item.rule))].sort();
    assert.deepEqual(hitRules, [ruleId]);
    assert.ok(report.findings.length >= 1);

    const reported = report.rules.find((rule) => rule.id === ruleId);
    assert.ok(reported.findings >= 1);
    assert.equal(reported.enabled, true);

    for (const item of report.findings) {
      assert.equal(item.rule, ruleId);
      assert.ok(['fail', 'warn', 'info'].includes(item.severity));
      assert.ok(item.title.length > 0);
      assert.ok(item.detail.length > 0);
      assert.ok(Array.isArray(item.paths));
      for (const p of item.paths) assert.ok(path.isAbsolute(p), `${p} should be absolute`);
      assert.deepEqual(item.paths, [...item.paths].sort(), 'paths must be sorted');
      assert.equal(typeof item.fixable, 'boolean');
    }
  });
}

test('truncation is reported instead of throwing (maxEntries)', async (t) => {
  const fixture = await withFixture(t, 'clean');
  const report = await audit({ ...auditOpts(fixture), limits: { maxEntries: 3 } });

  assert.equal(report.stats.truncated, true);
  assert.ok(report.stats.entries <= 3);
});

test('truncation is reported instead of throwing (maxDepth)', async (t) => {
  const fixture = await withFixture(t, 'clean');
  const report = await audit({ ...auditOpts(fixture), limits: { maxDepth: 1 } });

  assert.equal(report.stats.truncated, true);
  for (const item of report.rules) assert.ok(item.findings >= 0);
});

test('walkConcurrency and hashConcurrency change speed, not results', async (t) => {
  const fixture = await withFixture(t, 'studio-mini');
  const serial = await audit({
    ...auditOpts(fixture),
    limits: { walkConcurrency: 1, hashConcurrency: 1 },
  });
  const parallel = await audit({
    ...auditOpts(fixture),
    limits: { walkConcurrency: 32, hashConcurrency: 8 },
  });

  assert.equal(serial.overall, parallel.overall);
  assert.deepEqual(serial.counts, parallel.counts);
  assert.deepEqual(
    serial.findings.map((item) => item.id),
    parallel.findings.map((item) => item.id),
  );
  assert.deepEqual(serial.stats.entries, parallel.stats.entries);
  assert.deepEqual(serial.composition, parallel.composition);
});

test('two audits of the same tree are deterministic', async (t) => {
  const fixture = await withFixture(t, 'studio-mini');
  const first = await audit(auditOpts(fixture));
  const second = await audit(auditOpts(fixture));

  assert.deepEqual(first.counts, second.counts);
  assert.deepEqual(
    first.findings.map((item) => [item.id, item.rule, item.paths]),
    second.findings.map((item) => [item.id, item.rule, item.paths]),
  );
  assert.deepEqual(first.composition, second.composition);
  assert.notEqual(first.generatedAt, undefined);
});

test('onlyRules restricts the run to the named rules', async (t) => {
  const fixture = await withFixture(t, 'studio-mini');
  const report = await audit({ ...auditOpts(fixture), onlyRules: ['duplicates'] });

  const enabled = report.rules.filter((rule) => rule.enabled).map((rule) => rule.id);
  assert.deepEqual(enabled, ['duplicates']);
  assert.ok(report.findings.length > 0);
  for (const item of report.findings) assert.equal(item.rule, 'duplicates');
});

test('formatReport renders json, text and markdown', async (t) => {
  const fixture = await withFixture(t, 'studio-mini');
  const report = await audit(auditOpts(fixture));

  const json = JSON.parse(formatReport(report, 'json'));
  assert.equal(json.overall, report.overall);
  assert.equal(json.findings.length, report.findings.length);

  const text = formatReport(report, 'text');
  assert.match(text, /overall: FAIL/);
  assert.match(text, /findings \(\d+\)/);
  assert.match(text, /composition/);

  const markdown = formatReport(report, 'markdown');
  assert.match(markdown, /^# Layout audit/);
  assert.match(markdown, /## Findings/);
  assert.match(markdown, /\| Rule \| Enabled \|/);

  assert.equal(formatReport(report, 'md'), markdown);
  assert.equal(formatReport(report, 'text'), formatReport(report));
});
