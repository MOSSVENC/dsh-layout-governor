/**
 * Fix-plan safety: the script header, the dry-run default, and the one
 * invariant that must never break — a protected path is never deleted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildFixture } from '../fixtures/build.mjs';
import { audit, buildFixPlan } from '../lib/engine/index.js';

async function withFixture(t, name) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-fixplan-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return buildFixture(name, dir);
}

test('the generated script is a guarded dry run', async (t) => {
  const fixture = await withFixture(t, 'studio-mini');
  const report = await audit({
    root: fixture.root,
    policyPath: fixture.policyPath,
    registryPath: fixture.registryPath,
  });
  const plan = buildFixPlan(report);

  assert.ok(plan.script.startsWith('#!/usr/bin/env bash\n'));
  assert.match(plan.script, /\nset -eu\n/);
  assert.match(plan.script, /\[dry-run\]/);
  assert.match(plan.script, /APPLY="\$\{APPLY:-0\}"/);
  assert.match(plan.script, /DRY-RUN BY DEFAULT/);
  assert.match(plan.script, /DSH_LAYOUT_FIX_PLAN/);

  for (const action of plan.actions) {
    assert.ok(plan.script.includes(action.command), 'every action must appear in the script');
  }

  // Markdown mirrors the script and repeats the dry-run instruction.
  assert.match(plan.markdown, /## Fix plan/);
  assert.match(plan.markdown, /Dry run/i);
  assert.match(plan.markdown, /```bash/);
});

test('protected paths never appear in a delete command', async (t) => {
  const fixture = await withFixture(t, 'duplicates-protected');
  const report = await audit({
    root: fixture.root,
    policyPath: fixture.policyPath,
    registryPath: fixture.registryPath,
  });

  const duplicates = report.findings.find((finding) => finding.rule === 'duplicates');
  assert.ok(duplicates, 'the fixture must produce a duplicates finding');
  assert.equal(duplicates.fixable, false, 'a finding touching a protected path is not auto-fixable');

  const protectedPaths = duplicates.evidence.protectedPaths;
  assert.equal(protectedPaths.length, 1);
  const [protectedPath] = protectedPaths;
  assert.ok(protectedPath.includes(`${path.sep}writings${path.sep}writer${path.sep}`));

  const plan = buildFixPlan(report);
  const deletes = plan.actions.filter((action) => action.kind === 'delete');
  assert.ok(deletes.length >= 1, 'the unprotected copies are still deletable');
  for (const action of deletes) {
    assert.ok(
      !action.paths.some((item) => protectedPaths.includes(item)),
      'no delete may name a protected path',
    );
    assert.ok(action.command.startsWith('rm -f -- '));
  }

  for (const action of plan.actions) {
    if (action.kind === 'delete') {
      assert.equal(action.paths.includes(protectedPath), false);
      assert.equal(action.command.includes(protectedPath), false);
    }
    assert.equal(/^rm\s/.test(action.command) && action.command.includes(protectedPath), false);
  }

  // Either the protected copy is the one the keep policy preserves, or it needs a
  // review action — both are correct, and which one holds depends on the keeper.
  const review = plan.actions.find(
    (action) => action.kind === 'review' && action.paths.includes(protectedPath),
  );
  const kept = duplicates.evidence.keep === protectedPath;
  assert.ok(
    review !== undefined || kept,
    'a protected copy is either kept or handed to a human for review',
  );
  if (review !== undefined) assert.equal(review.risk, 'high');
});

test('every delete command is quoted and uses --', async (t) => {
  const fixture = await withFixture(t, 'studio-mini');
  const report = await audit({
    root: fixture.root,
    policyPath: fixture.policyPath,
    registryPath: fixture.registryPath,
  });
  const plan = buildFixPlan(report);

  for (const action of plan.actions) {
    if (action.kind !== 'delete') continue;
    assert.match(action.command, /^rm -f -- '/);
    for (const target of action.paths) {
      assert.ok(action.command.includes(`'${target}'`), `${target} must be single-quoted`);
      assert.ok(path.isAbsolute(target));
    }
  }
});

test('a green report produces no actions', async (t) => {
  const fixture = await withFixture(t, 'clean');
  const report = await audit({
    root: fixture.root,
    policyPath: fixture.policyPath,
    registryPath: fixture.registryPath,
  });
  const plan = buildFixPlan(report);

  assert.equal(report.overall, 'pass');
  assert.deepEqual(plan.actions, []);
  assert.match(plan.markdown, /No actions/);
  assert.ok(plan.script.startsWith('#!/usr/bin/env bash\n'));
});

test('docs findings become edit-doc actions, never deletes', async (t) => {
  const fixture = await withFixture(t, 'docs-drift');
  const report = await audit({
    root: fixture.root,
    policyPath: fixture.policyPath,
    registryPath: fixture.registryPath,
  });
  const plan = buildFixPlan(report);

  assert.ok(plan.actions.length >= 1);
  for (const action of plan.actions) {
    assert.equal(action.kind, 'edit-doc');
    assert.equal(action.risk, 'low');
    assert.equal(/\brm\b/.test(action.command), false, 'a doc fix must never delete anything');
  }
});

test('move-to-archive actions create the archive directory first', async (t) => {
  const fixture = await withFixture(t, 'backup-location');
  const report = await audit({
    root: fixture.root,
    policyPath: fixture.policyPath,
    registryPath: fixture.registryPath,
  });
  const plan = buildFixPlan(report);

  const moves = plan.actions.filter((action) => action.kind === 'move-to-archive');
  assert.ok(moves.length >= 1);
  for (const action of moves) {
    assert.match(action.command, /^mkdir -p -- '.*' && mv -- '/);
    const destination = /&& mv -- '[^']*' '(.*)'$/.exec(action.command);
    assert.ok(destination, 'move command must have a destination');
    assert.match(path.basename(destination[1]), /^\d{8}_[a-z0-9_-]+/);
  }
});
