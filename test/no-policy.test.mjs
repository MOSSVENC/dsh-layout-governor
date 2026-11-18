/**
 * No policy file means no verdict.
 *
 * Auditing an ungoverned directory with built-in defaults would be a guess, so a
 * missing `layout.policy.yml` disables every rule. This pairs with
 * `negative-control.test.mjs`: red comes from the policy file, never from the
 * engine's constants.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildFixture } from '../fixtures/build.mjs';
import { audit, formatReport } from '../lib/engine/index.js';

async function fixtureTree(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-nopolicy-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const fixture = await buildFixture('duplicates', dir);
  return { dir, fixture };
}

test('without a policy file nothing is enforced', async (t) => {
  const { fixture } = await fixtureTree(t);
  // The fixture keeps its policy next to the tree; the audit root itself has none,
  // so the default `<root>/layout.policy.yml` really is absent.
  const report = await audit({ root: fixture.root });

  assert.equal(report.policy.present, false);
  assert.equal(report.overall, 'pass');
  assert.deepEqual(report.counts, { fail: 0, warn: 0, info: 0 });
  assert.deepEqual(report.findings, []);
  assert.ok(report.rules.every((rule) => rule.enabled === false));
  assert.ok(report.rules.every((rule) => rule.findings === 0));

  // The tree is still measured (3 wim copies + the fixture README), it is just
  // not judged: no policy means no verdict.
  assert.ok(report.stats.files >= 3);
  assert.ok(report.stats.bytes > 0);
  assert.equal(report.stats.truncated, false);
});

test('the same tree turns red once the policy is present', async (t) => {
  const { fixture } = await fixtureTree(t);
  const green = await audit({ root: fixture.root });
  assert.equal(green.overall, 'pass');

  const withPolicy = await audit({
    root: fixture.root,
    policyPath: fixture.policyPath,
    registryPath: fixture.registryPath,
  });
  assert.equal(withPolicy.overall, 'fail');
  assert.ok(withPolicy.counts.fail >= 1);
  assert.equal(withPolicy.findings[0].rule, 'duplicates');
});

test('picking up the policy from the default path is enough', async (t) => {
  const { fixture } = await fixtureTree(t);
  await copyFile(fixture.policyPath, path.join(fixture.root, 'layout.policy.yml'));

  const report = await audit({ root: fixture.root });
  assert.equal(report.policy.present, true);
  assert.equal(report.overall, 'fail');
  assert.ok(report.findings.some((finding) => finding.rule === 'duplicates'));
});

test('both output formats say that no policy was found', async (t) => {
  const { fixture } = await fixtureTree(t);
  const report = await audit({ root: fixture.root });

  const text = formatReport(report, 'text');
  assert.match(text, /no policy file found/i);
  assert.match(text, /nothing is enforced/i);
  assert.match(text, /overall: PASS/);

  const markdown = formatReport(report, 'markdown');
  assert.match(markdown, /## No policy/);
  assert.match(markdown, /nothing is\s+enforced/i);
});
