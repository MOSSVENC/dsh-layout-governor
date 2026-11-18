/**
 * Negative control — the single most important test in this package.
 *
 * If `allRulesOff` cannot turn the dirtiest fixture green, then red comes from a
 * constant in the engine rather than from the rules, and every other test in the
 * suite is worthless. Both switch paths are exercised:
 *   1. run-level  `allRulesOff: true`
 *   2. a real policy file with every `enabled: false`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildFixture, writePolicyFile } from '../fixtures/build.mjs';
import { audit, formatReport } from '../lib/engine/index.js';

async function dirtiest(t, name = 'studio-mini') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-negative-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const fixture = await buildFixture(name, dir);
  return { dir, fixture };
}

test('allRulesOff turns the dirtiest fixture green', async (t) => {
  const { fixture } = await dirtiest(t);
  const options = { root: fixture.root, policyPath: fixture.policyPath, registryPath: fixture.registryPath };

  const on = await audit(options);
  assert.equal(on.overall, 'fail', 'the control run must be red, otherwise the fixture is not dirty');
  assert.ok(on.counts.fail > 0);

  const off = await audit({ ...options, allRulesOff: true });
  assert.equal(off.overall, 'pass');
  assert.deepEqual(off.counts, { fail: 0, warn: 0, info: 0 });
  assert.deepEqual(off.findings, []);
  assert.equal(off.rules.length, 7);
  assert.ok(off.rules.every((rule) => rule.enabled === false));
  assert.ok(off.rules.every((rule) => rule.findings === 0));

  // The tree is still walked: "off" means no verdict, not no information.
  assert.ok(off.stats.entries > 0);
  assert.ok(off.composition.classes.length === 4);
});

test('a policy file with every rule disabled is green too', async (t) => {
  const { dir, fixture } = await dirtiest(t);
  const document = JSON.parse(JSON.stringify(fixture.policy));
  for (const block of Object.values(document.rules)) block.enabled = false;

  const disabledPolicy = await writePolicyFile(path.join(dir, 'layout.policy.all-off.yml'), document);
  const report = await audit({
    root: fixture.root,
    policyPath: disabledPolicy,
    registryPath: fixture.registryPath,
  });

  assert.equal(report.overall, 'pass');
  assert.deepEqual(report.counts, { fail: 0, warn: 0, info: 0 });
  assert.deepEqual(report.findings, []);
  assert.ok(report.rules.every((rule) => rule.enabled === false));
  assert.equal(report.policy.present, true, 'the policy file exists, it just asks for silence');
});

test('one rule disabled silences only that rule', async (t) => {
  const { dir, fixture } = await dirtiest(t);
  const document = JSON.parse(JSON.stringify(fixture.policy));
  document.rules.duplicates.enabled = false;

  const partialPolicy = await writePolicyFile(path.join(dir, 'layout.policy.no-duplicates.yml'), document);
  const report = await audit({
    root: fixture.root,
    policyPath: partialPolicy,
    registryPath: fixture.registryPath,
  });

  const duplicates = report.rules.find((rule) => rule.id === 'duplicates');
  assert.equal(duplicates.enabled, false);
  assert.equal(duplicates.findings, 0);
  assert.equal(report.findings.some((finding) => finding.rule === 'duplicates'), false);
  assert.ok(report.findings.some((finding) => finding.rule !== 'duplicates'), 'other rules still report');
});

test('an all-off report formats without inventing findings', async (t) => {
  const { fixture } = await dirtiest(t);
  const report = await audit({
    root: fixture.root,
    policyPath: fixture.policyPath,
    registryPath: fixture.registryPath,
    allRulesOff: true,
  });

  const text = formatReport(report, 'text');
  assert.match(text, /overall: PASS/);
  assert.match(text, /fail 0 \| warn 0 \| info 0/);
  assert.match(text, /findings: none/);

  const markdown = formatReport(report, 'markdown');
  assert.match(markdown, /- \*\*Overall:\*\* PASS/);
  assert.match(markdown, /None\./);
});
