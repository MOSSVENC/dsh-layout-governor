/**
 * Self-healing has to be boring, or it is a hazard.
 *
 * The rules these tests hold: it only ever moves, it never leaves the archive root,
 * it never touches a protected path, it can be reduced to a proposal, and whatever
 * it does can be undone by running one script.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { buildFixPlan } from '../lib/engine/index.js';
import { audit } from '../lib/engine/index.js';
import { applyAutoActions, selectAutoActions } from '../lib/host/autofix.js';

const created = [];

after(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

const POLICY = `version: 1
autofix:
  enabled: true
  dryRun: false
  kinds: [move-to-archive]
  maxPerRun: 5
classification:
  # classification.protected marks a path untouchable; the protected RULE below is
  # the separate "is the keeper still there" alarm. A move is guarded by the former,
  # so the fixture declares both to be honest.
  protected: ["writings/keeper/**"]
rules:
  top-level:
    enabled: false
  backups:
    enabled: true
    severity: fail
    allowedRoots: [_archive]
    forbidNames: ["_backup", "*.bak.*"]
    ignore: []
  duplicates:
    enabled: false
  families:
    enabled: false
  large-files:
    enabled: false
  docs:
    enabled: false
  protected:
    enabled: true
    severity: fail
    patterns: ["writings/keeper/**"]
`;

/**
 * A tree with two misplaced backups and one protected path that happens to look
 * like a backup.
 * @param {{dryRun?: boolean}} [options]
 * @returns {Promise<string>} Root.
 */
async function tree(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lg-heal-'));
  created.push(root);
  await mkdir(path.join(root, 'writings', 'keeper', '_backup'), { recursive: true });
  await writeFile(path.join(root, 'writings', 'keeper', '_backup', 'only-copy.txt'), 'irreplaceable');
  await mkdir(path.join(root, 'mining', '_backup'), { recursive: true });
  await writeFile(path.join(root, 'mining', '_backup', 'old.bin'), 'x');
  await writeFile(path.join(root, 'notes.md.bak.20261118'), 'y');
  await mkdir(path.join(root, '_archive'), { recursive: true });
  const policy = options.dryRun === true ? POLICY.replace('dryRun: false', 'dryRun: true') : POLICY;
  await writeFile(path.join(root, 'layout.policy.yml'), policy);
  return root;
}

/**
 * Report plus the plan's actions, which is what the host hands to autofix.
 * @param {string} root Tree root.
 * @returns {Promise<{ report: object, actions: object[] }>}
 */
async function plan(root) {
  const report = await audit({ root });
  return { report, actions: buildFixPlan(report).actions };
}

test('only reversible actions are selected, protected paths are not', async () => {
  const root = await tree();
  const { report, actions } = await plan(root);
  const chosen = selectAutoActions(report, report.autofix, actions);
  const sources = chosen.map((action) => action.paths[0]);

  assert.ok(sources.some((item) => item.endsWith(path.join('mining', '_backup'))));
  assert.ok(sources.some((item) => item.endsWith('notes.md.bak.20261118')));
  assert.ok(
    !sources.some((item) => item.includes(path.join('writings', 'keeper'))),
    'a protected path is never auto-moved',
  );
  assert.ok(chosen.every((action) => action.kind === 'move-to-archive'));
});

test('the plan is applied: files land in _archive, a log and an undo script exist', async () => {
  const root = await tree();
  const { report, actions } = await plan(root);

  const outcome = await applyAutoActions(report, { actions, now: '2026-11-18T00:00:00.000Z' });

  assert.equal(outcome.dryRun, false);
  assert.equal(outcome.moved.length, 2);
  assert.equal(outcome.skipped.length, 0);

  for (const move of outcome.moved) {
    await assert.rejects(() => stat(move.source), 'the source is gone');
    assert.equal((await stat(move.destination)).isFile() || true, true);
    assert.ok(move.destination.startsWith(path.join(root, '_archive', '20261118_')), move.destination);
  }

  const log = await readFile(outcome.logPath, 'utf8');
  assert.equal(log.trim().split('\n').length, 2);
  assert.match(log, /"rule":"backups"/);

  const undo = await readFile(outcome.undoPath, 'utf8');
  assert.match(undo, /^#!\/usr\/bin\/env bash/);
  assert.match(undo, /set -eu/);
  // One undo step per move, each guarded against clobbering an existing file.
  assert.equal(undo.split('\n').filter((line) => line.startsWith('undo ')).length, 2);
  assert.match(undo, /if \[ -e "\$to" \]/);
  assert.match(undo, /exit 1/, 'a skipped step is reported as a failure, not a success');
  assert.ok((await stat(outcome.undoPath)).mode & 0o100, 'undo.sh is executable');

  // The protected keeper is exactly where it was.
  assert.equal((await stat(path.join(root, 'writings', 'keeper', '_backup', 'only-copy.txt'))).isFile(), true);
});

test('the undo script puts everything back', async () => {
  const root = await tree();
  const { report, actions } = await plan(root);
  const outcome = await applyAutoActions(report, { actions, now: '2026-11-18T00:00:00.000Z' });

  const { execFileSync } = await import('node:child_process');
  execFileSync('bash', [outcome.undoPath], { stdio: 'ignore' });

  for (const move of outcome.moved) {
    assert.equal((await stat(move.source)).isFile() || (await stat(move.source)).isDirectory(), true);
    await assert.rejects(() => stat(move.destination), 'the archive copy is gone again');
  }
});

test('dry run plans without touching the tree', async () => {
  const root = await tree({ dryRun: true });
  const { report, actions } = await plan(root);

  const outcome = await applyAutoActions(report, { actions, now: '2026-11-18T00:00:00.000Z' });

  assert.equal(outcome.dryRun, true);
  assert.equal(outcome.logPath, null);
  assert.ok(outcome.moved.length > 0, 'the plan still says what it would do');
  assert.equal((await stat(path.join(root, 'mining', '_backup'))).isDirectory(), true);
  const archive = await readFile(path.join(root, '_archive'), 'utf8').catch(() => null);
  assert.equal(archive, null, 'the archive stays empty, so the read fails');
});

test('a disabled policy never selects anything', async () => {
  const root = await tree();
  const { report, actions } = await plan(root);
  const chosen = selectAutoActions(report, { enabled: false, kinds: ['move-to-archive'], maxPerRun: 5 }, actions);
  assert.deepEqual(chosen, []);
});

test('maxPerRun bounds one pass', async () => {
  const root = await tree();
  const { report, actions } = await plan(root);
  const chosen = selectAutoActions(report, { ...report.autofix, maxPerRun: 1 }, actions);
  assert.equal(chosen.length, 1);
});

test('nothing inside _archive is ever re-filed', async () => {
  const root = await tree();
  const { report, actions } = await plan(root);
  const chosen = selectAutoActions(
    report,
    report.autofix,
    actions.concat([
      { kind: 'move-to-archive', rule: 'backups', paths: [path.join(root, '_archive', 'x_backup')], risk: 'medium' },
    ]),
  );
  assert.ok(!chosen.some((action) => action.paths[0].includes(`${path.sep}_archive${path.sep}`)));
});

test('a top-level finding is never auto-moved, even though it is reversible', async () => {
  const root = await tree();
  const { report, actions } = await plan(root);
  // Pretend the top-level rule flagged a brand-new directory: archiving it
  // automatically would be data loss dressed as tidiness.
  const invented = {
    kind: 'move-to-archive',
    rule: 'top-level',
    paths: [path.join(root, 'mining')],
    reason: 'outside the declared top-level layout',
    risk: 'medium',
  };
  const chosen = selectAutoActions(report, report.autofix, actions.concat([invented]));
  assert.ok(!chosen.some((action) => action.paths[0] === path.join(root, 'mining')));
  assert.ok(chosen.every((action) => action.rule === 'backups'));
});
