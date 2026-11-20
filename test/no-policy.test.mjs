/**
 * A policy governs the tree it sits in and every tree below it.
 *
 * Two behaviours are pinned here. A tree with no policy anywhere above it gets no
 * verdict — auditing it with built-in defaults would be a guess. And a policy in an
 * ancestor applies to a subtree without a flag: auditing `studio/video` must obey
 * `studio/layout.policy.yml`, the way `.git` is found, otherwise every subtree audit
 * needs a flag and a forgotten flag reads as "compliant".
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { audit, formatReport } from '../lib/engine/index.js';

const created = [];

after(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

// Only the rule the file names runs; the others stay off. That is the documented
// meaning of a partial policy, and it is what makes a 4-line file useful.
const POLICY = `version: 1
rules:
  duplicates:
    enabled: true
    severity: fail
    minBytes: 1024
    maxCopies: 1
`;

/**
 * Three byte-identical files with no policy anywhere above them.
 *
 * The tree sits one level below the temporary directory so a test can drop a policy
 * into the ancestor and watch it apply.
 * @returns {Promise<{ parent: string, root: string }>}
 */
async function bareTree() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'lg-policy-'));
  created.push(parent);
  const root = path.join(parent, 'tree');
  await mkdir(path.join(root, 'writings'), { recursive: true });
  const payload = Buffer.alloc(2048, 3);
  await writeFile(path.join(root, 'writings', 'a.wim'), payload);
  await writeFile(path.join(root, 'writings', 'b.wim'), payload);
  await writeFile(path.join(root, 'c.wim'), payload);
  return { parent, root };
}

test('without a policy file nothing is enforced, and the verdict says so', async () => {
  const { root } = await bareTree();
  const report = await audit({ root });

  assert.equal(report.policy.present, false);
  assert.equal(report.policy.inherited, false);
  // L1: missing configuration and a clean tree must not look the same. Nothing is
  // reported against this tree, and the verdict still cannot claim green.
  assert.equal(report.overall, 'warn');
  assert.equal(report.verdictReason, 'no-policy');
  assert.equal(report.policy.state, 'absent');
  // L2: no hash, because nothing was read.
  assert.equal(report.policy.sha256, null);
  assert.equal(report.policy.source, 'defaults');
  // L9: the gate's vocabulary is visible even when the file is missing.
  assert.deepEqual(report.policy.topLevel.allow, []);
  assert.deepEqual(report.counts, { fail: 0, warn: 0, info: 0 });
  assert.deepEqual(report.findings, []);
  assert.ok(report.rules.every((rule) => rule.enabled === false));
  assert.ok(report.rules.every((rule) => rule.findings === 0));

  // The tree is still measured, it is just not judged.
  assert.ok(report.stats.files >= 3);
  assert.ok(report.stats.bytes > 0);
});

test('the same tree turns red once the policy is present', async () => {
  const { root } = await bareTree();
  assert.equal((await audit({ root })).overall, 'warn');

  await writeFile(path.join(root, 'layout.policy.yml'), POLICY);
  const report = await audit({ root });

  assert.equal(report.policy.present, true);
  assert.equal(report.policy.inherited, false);
  assert.equal(report.overall, 'fail');
  assert.equal(report.findings[0].rule, 'duplicates');
});

test('a policy in an ancestor governs the subtree, without a flag', async () => {
  const { parent, root } = await bareTree();
  await writeFile(path.join(parent, 'layout.policy.yml'), POLICY);

  const report = await audit({ root });

  assert.equal(report.policy.present, true);
  assert.equal(report.policy.inherited, true, 'the report says the policy was found above the root');
  assert.equal(report.policy.path, path.join(parent, 'layout.policy.yml'));
  assert.equal(report.overall, 'fail');
  assert.ok(report.findings.some((finding) => finding.rule === 'duplicates'));
});

test('an explicit path overrides discovery', async () => {
  const { parent, root } = await bareTree();
  await writeFile(path.join(parent, 'layout.policy.yml'), POLICY);
  const other = path.join(root, 'strict.yml');
  await writeFile(other, POLICY.replace('maxCopies: 1', 'maxCopies: 3'));

  const report = await audit({ root, policyPath: other });

  assert.equal(report.policy.path, other);
  assert.equal(report.policy.inherited, false);
  assert.equal(report.overall, 'pass', 'maxCopies 3 tolerates this trio');
});

test('both output formats say that no policy was found', async () => {
  const { root } = await bareTree();
  const report = await audit({ root });

  const text = formatReport(report, 'text');
  assert.match(text, /no policy file found/i);
  assert.match(text, /never judged against this workspace/i);
  assert.match(text, /overall: WARN   fail 0 .* \(no-policy\)/);

  const markdown = formatReport(report, 'markdown');
  assert.match(markdown, /## No policy/);
  assert.match(markdown, /never judged against this workspace/i);
});
