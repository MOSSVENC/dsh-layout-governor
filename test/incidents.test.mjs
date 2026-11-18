/**
 * The six real incidents, reproduced 1:1 in a synthetic tree.
 *
 * Each incident is asserted by rule id plus a keyword that can only come from
 * that incident, so a rule that silently stops working fails here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildFixture } from '../fixtures/build.mjs';
import { audit, buildFixPlan } from '../lib/engine/index.js';

const INCIDENTS = [
  {
    name: '1. install.wim stored three times',
    rule: 'duplicates',
    includes: ['install.wim'],
    evidence: (report) => {
      const item = report.findings.find((f) => f.rule === 'duplicates');
      return item.evidence.copies === 3 && item.evidence.reclaimableBytes > 0;
    },
  },
  {
    name: '2. four ISOs in one image directory',
    rule: 'families',
    includes: ['.iso'],
    evidence: (report) => {
      const item = report.findings.find((f) => f.rule === 'families');
      return item.evidence.count === 4 && item.evidence.maxPer === 2;
    },
  },
  {
    name: '3a. _backup directory inside a domain tree',
    rule: 'backups',
    includes: ['writings/_backup'],
    evidence: () => true,
  },
  {
    name: '3b. *.bak directory left in place',
    rule: 'backups',
    includes: ['love.bak'],
    evidence: () => true,
  },
  {
    name: '4. README still advertises the old directory names',
    rule: 'docs',
    includes: ['quill'],
    evidence: (report) => report.findings.filter((f) => f.rule === 'docs').length === 4,
  },
  {
    name: '5. transcribed raw originals never removed',
    rule: 'large-files',
    includes: ['xinghe/raw', '.mkv'],
    evidence: () => true,
  },
  {
    name: '6. 29 GB vhdx nobody registered',
    rule: 'large-files',
    includes: ['vhdx'],
    evidence: () => true,
  },
];

function haystack(finding) {
  return [
    finding.title,
    finding.detail,
    finding.suggestion,
    finding.paths.join('\n'),
    JSON.stringify(finding.evidence),
  ].join('\n');
}

test('studio-mini reproduces every incident and fails overall', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-incidents-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const fixture = await buildFixture('studio-mini', dir);
  const report = await audit({
    root: fixture.root,
    policyPath: fixture.policyPath,
    registryPath: fixture.registryPath,
  });

  assert.equal(report.overall, 'fail');
  assert.ok(report.counts.fail >= 6, `expected at least 6 failures, got ${report.counts.fail}`);
  assert.ok(report.findings.length >= 6);

  for (const incident of INCIDENTS) {
    const match = report.findings.find(
      (finding) =>
        finding.rule === incident.rule &&
        incident.includes.every((needle) => haystack(finding).includes(needle)),
    );
    assert.ok(match, `incident not detected: ${incident.name} (rule ${incident.rule})`);
    assert.equal(match.severity === 'fail' || match.severity === 'warn', true);
    assert.ok(incident.evidence(report), `incident evidence missing: ${incident.name}`);
  }
});

test('studio-mini keeps the guardrails quiet (no false positives)', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-incidents-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const fixture = await buildFixture('studio-mini', dir);
  const report = await audit({
    root: fixture.root,
    policyPath: fixture.policyPath,
    registryPath: fixture.registryPath,
  });

  const byRule = new Map(report.rules.map((rule) => [rule.id, rule]));
  assert.equal(byRule.get('top-level').findings, 0, 'declared directories must not be flagged');
  assert.equal(byRule.get('protected').findings, 0, 'both orphans are still on disk');
  assert.equal(byRule.get('backups').findings, 2, 'exactly one finding per misplaced backup root');

  const registryFile = report.findings.find((f) => f.rule === 'large-files' && haystack(f).includes('7705047215923976320'));
  assert.equal(registryFile, undefined, 'a registered orphan must not be reported as unregistered');
});

test('every fixed incident produces a runnable command', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-incidents-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const fixture = await buildFixture('studio-mini', dir);
  const report = await audit({
    root: fixture.root,
    policyPath: fixture.policyPath,
    registryPath: fixture.registryPath,
  });
  const plan = buildFixPlan(report);

  assert.ok(plan.actions.length >= 6, `expected at least 6 actions, got ${plan.actions.length}`);
  for (const action of plan.actions) {
    assert.equal(typeof action.command, 'string');
    assert.ok(action.command.length > 0, `action without command: ${JSON.stringify(action)}`);
    assert.ok(!action.command.includes('\n'), 'a command must be a single line');
    assert.ok(['delete', 'move-to-archive', 'edit-doc', 'register', 'review'].includes(action.kind));
    assert.ok(['low', 'medium', 'high'].includes(action.risk));
    assert.ok(action.reason.length > 0);
    assert.ok(Array.isArray(action.paths));
  }

  const rulesWithActions = new Set(plan.actions.map((action) => action.rule));
  for (const ruleId of ['duplicates', 'families', 'backups', 'docs', 'large-files']) {
    assert.ok(rulesWithActions.has(ruleId), `no action produced for ${ruleId}`);
  }
  assert.match(plan.markdown, /## Fix plan/);
  assert.match(plan.script, /#!/);
});
