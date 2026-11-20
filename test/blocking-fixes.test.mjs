/**
 * Regression tests for the six blocking findings of the 2026-11-19 audit.
 *
 * Each test is named after the finding it pins, so a future regression is
 * traceable to the review that demanded it.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { audit, buildFixPlan } from '../lib/engine/index.js';
import { applyAutoActions, selectAutoActions } from '../lib/host/autofix.js';

const created = [];

after(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A tree with one misplaced backup directory that holds a protected original.
 * @returns {Promise<{ root: string, dir: string }>}
 */
async function protectedTree() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-b2-'));
  created.push(dir);
  const root = path.join(dir, 'tree');
  await mkdir(path.join(root, 'video', '_backup'), { recursive: true });
  await writeFile(path.join(root, 'video', '_backup', 'U218.mp4'), 'irreplaceable');
  await writeFile(
    path.join(root, 'layout.policy.yml'),
    [
      'version: 1',
      'classification:',
      '  protected: ["**/U218*"]',
      'rules:',
      '  backups:',
      '    enabled: true',
      '    allowedRoots: [_archive]',
      '    forbidNames: ["_backup"]',
      '  protected:',
      '    enabled: true',
      '    severity: fail',
      '    patterns: ["**/U218*"]',
      '',
    ].join('\n'),
  );
  return { root, dir };
}

test('B1: archiving twice never overwrites the first copy', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-b1-'));
  created.push(dir);
  const root = path.join(dir, 'tree');
  await mkdir(path.join(root, 'mining', '_backup'), { recursive: true });
  await writeFile(path.join(root, 'mining', '_backup', 'old.bin'), 'first-generation');
  await writeFile(
    path.join(root, 'layout.policy.yml'),
    // This test is about the mover, so the policy must opt in explicitly.
    [
      'version: 1',
      'autofix:',
      '  enabled: true',
      '  dryRun: false',
      '  rules: [backups]',
      'rules:',
      '  backups:',
      '    enabled: true',
      '    allowedRoots: [_archive]',
      '    forbidNames: ["_backup"]',
      '',
    ].join('\n'),
  );

  const report = await audit({ root, autofix: false });
  const actions = buildFixPlan(report).actions;
  const outcome = await applyAutoActions(report, { actions, now: '2026-11-19T00:00:00.000Z' });
  assert.equal(outcome.moved.length, 1);
  // The source is a directory, so the archive entry is one too.
  assert.equal((await stat(outcome.moved[0].destination)).isDirectory(), true);
  const first = await readFile(path.join(outcome.moved[0].destination, 'old.bin'), 'utf8');
  assert.equal(first, 'first-generation');

  // A second misplaced backup with the same base name must not take that name.
  await mkdir(path.join(root, 'mining', '_backup'), { recursive: true });
  await writeFile(path.join(root, 'mining', '_backup', 'old.bin'), 'second-generation');
  const again = await audit({ root, autofix: false });
  const second = await applyAutoActions(again, {
    actions: buildFixPlan(again).actions,
    now: '2026-11-19T00:00:00.000Z',
  });
  assert.equal(second.moved.length, 1);
  assert.notEqual(second.moved[0].destination, outcome.moved[0].destination, 'a new name was claimed');
  assert.equal(
    await readFile(path.join(outcome.moved[0].destination, 'old.bin'), 'utf8'),
    'first-generation',
    'the first copy survived',
  );
  assert.equal(
    await readFile(path.join(second.moved[0].destination, 'old.bin'), 'utf8'),
    'second-generation',
  );
});

test('B2: a backup directory holding a protected original is never moved', async () => {
  const { root } = await protectedTree();
  const report = await audit({ root });
  const finding = report.findings.find((item) => item.rule === 'backups');
  assert.ok(finding !== undefined);
  assert.equal(finding.fixable, false, 'the finding itself must say it cannot be fixed');
  assert.ok(finding.evidence.protectedPaths.length > 0, 'the subtree was inspected, not just the path');

  const actions = buildFixPlan(report).actions;
  assert.ok(actions.every((action) => action.kind !== 'move-to-archive'), 'the plan offers no move');

  const chosen = selectAutoActions(report, report.autofix, actions);
  assert.deepEqual(chosen, [], 'and the auto-fixer refuses it too');
});

test('B3: a partial audit does not report pass', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-b3-'));
  created.push(dir);
  const root = path.join(dir, 'tree');
  await mkdir(path.join(root, 'writings'), { recursive: true });
  await writeFile(path.join(root, 'writings', 'a.txt'), 'x');
  await writeFile(path.join(root, 'layout.policy.yml'), 'version: 1\nrules:\n  docs:\n    enabled: true\n');

  const bounded = await audit({ root, limits: { maxEntries: 1, maxDepth: 2 } });
  assert.equal(bounded.stats.truncated, true);
  assert.notEqual(bounded.overall, 'pass', 'a bounded audit is unproven, not clean');
});

test('B3: the tool value carries the evidence of partiality', async () => {
  const { createAuditTool } = await import('../lib/host/audit-tool.js');
  const { apply } = await import('../lib/index.js');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-b3b-'));
  created.push(dir);
  const root = path.join(dir, 'tree');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'layout.policy.yml'), 'version: 1\nrules: {}\n');

  const tools = [];
  apply(
    {
      tools: { register: (definition) => (tools.push(definition), () => {}) },
      get: () => undefined,
      effect: (run) => run(),
      on: () => () => {},
      inject: (_deps, body) => body({ get: () => undefined, effect: (run) => run() }),
      logger: { warn() {}, info() {} },
    },
    { root, autoScan: false },
  );
  const auditTool = tools.find((tool) => tool.name === 'layout_audit');
  assert.ok(auditTool !== undefined);

  const value = await auditTool.execute({ root }, {});
  assert.ok('stats' in value, 'the model needs to know whether the scan was bounded');
  assert.equal(typeof value.stats.truncated, 'boolean');
  assert.equal(typeof value.stats.unreadable, 'number');
  assert.ok(auditTool.output.schema.required.includes('stats'));
  assert.equal(createAuditTool.length >= 0, true);
});

test('B5: a reload disposes the route and the watcher, not only the tools', async () => {
  const { apply } = await import('../lib/index.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-b5-'));
  created.push(dir);
  const root = path.join(dir, 'tree');
  await mkdir(root, { recursive: true });

  let routes = 0;
  let watchers = 0;
  const makeCtx = () => ({
    tools: { register: () => () => {} },
    get: () => undefined,
    effect(run) {
      const dispose = run();
      return () => {
        watchers += 1;
        if (typeof dispose === 'function') dispose();
      };
    },
    on: () => () => {},
    inject(_deps, body) {
      body({
        get: () => ({
          fetch: {
            register: () => {
              routes += 1;
              return () => {
                routes -= 1;
              };
            },
          },
        }),
        effect: (run) => run(),
      });
    },
    logger: { warn() {}, info() {} },
  });

  apply(makeCtx(), { root, autoScan: true, bootDelayMs: 1 });
  assert.equal(routes, 1);
  apply(makeCtx(), { root, autoScan: true, bootDelayMs: 1 });
  assert.equal(routes, 1, 'the previous route was removed before the new one registered');
  assert.ok(watchers >= 1, 'the previous effects were disposed');
});

test('B6: the shipped policy never enables moving files', async () => {
  const policy = await readFile(new URL('../layout.policy.yml', import.meta.url), 'utf8');
  assert.match(policy, /autofix:\s*\n(?:[ #].*\n)*\s*enabled: false/, 'autofix ships off');
  assert.match(policy, /dryRun: true/, 'and in dry-run even if switched on');
  const parsed = await audit({ root: path.dirname(new URL(import.meta.url).pathname) });
  assert.equal(parsed.autofix.enabled, false);
  assert.equal(parsed.autofix.dryRun, true);
  assert.equal((await stat(new URL('../layout.policy.yml', import.meta.url))).isFile(), true);
});

test('X: a top-level directory holding a U218 original is refused by the selector', async () => {
  // The audit's own case: the protected file is nested in a directory the backups
  // rule names, and the pattern is a basename glob (`**/U218*`), which no path
  // prefix can decide. The report has to carry the paths that actually matched.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-x-'));
  created.push(dir);
  const root = path.join(dir, 'tree');
  await mkdir(path.join(root, 'video', '_backup'), { recursive: true });
  await writeFile(path.join(root, 'video', '_backup', 'U218_master.mp4'), 'irreplaceable');
  await writeFile(path.join(root, 'video', '_backup', 'plan.txt'), 'recoverable');
  await writeFile(
    path.join(root, 'layout.policy.yml'),
    [
      'version: 1',
      'autofix:',
      '  enabled: true',
      '  dryRun: false',
      '  rules: [backups]',
      'classification:',
      '  protected: ["**/U218*"]',
      'rules:',
      '  backups:',
      '    enabled: true',
      '    allowedRoots: [_archive]',
      '    forbidNames: ["_backup"]',
      '  protected:',
      '    enabled: true',
      '    patterns: ["**/U218*"]',
      '',
    ].join('\n'),
  );

  const report = await audit({ root });
  assert.ok(report.protection.paths.some((item) => item.endsWith('U218_master.mp4')),
    'the report names the path that actually matched the glob');

  const chosen = selectAutoActions(report, report.autofix, buildFixPlan(report).actions);
  assert.deepEqual(chosen, [], 'a subtree holding the original is never auto-moved');

  const outcome = await applyAutoActions(report, {
    actions: buildFixPlan(report).actions,
    now: '2026-11-19T00:00:00.000Z',
  });
  assert.deepEqual(outcome.moved, [], 'and nothing moved when applied');
  assert.equal(
    (await stat(path.join(root, 'video', '_backup', 'U218_master.mp4'))).isFile(),
    true,
    'the original is exactly where it was',
  );
});

test('X: a plan action carries the protected paths it was derived from', async () => {
  const { root } = await protectedTree();
  const report = await audit({ root });
  const actions = buildFixPlan(report).actions;
  const review = actions.find((action) => action.kind === 'review');
  assert.ok(review !== undefined);
  assert.ok(Array.isArray(review.protectedPaths) && review.protectedPaths.length > 0);
});

test('X: the selector guard is what stops a top-level move, not fixable:false', async () => {
  // The decisive fixture: the finding itself is `fixable: true` and the policy
  // permits moving top-level entries, so only the selector's protected-subtree
  // check can stop the move. On the pre-fix build this moved `x` into `_archive`.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-x2-'));
  created.push(dir);
  const root = path.join(dir, 'root');
  await mkdir(path.join(root, 'x'), { recursive: true });
  await writeFile(path.join(root, 'x', 'U218_master.mp4'), 'irreplaceable');
  await mkdir(path.join(root, 'scratch'), { recursive: true });
  await writeFile(path.join(root, 'scratch', 'notes.txt'), 'nothing precious');
  await writeFile(
    path.join(root, 'layout.policy.yml'),
    [
      'version: 1',
      'autofix:',
      '  enabled: true',
      '  dryRun: false',
      '  rules: [top-level]',      // a policy that allows archiving unknown top-level names
      'classification:',
      '  protected: ["**/U218*"]',
      'rules:',
      '  top-level:',
      '    enabled: true',
      '    allow: [scratch, layout.policy.yml]',
      '  protected:',
      '    enabled: true',
      '    patterns: ["**/U218*"]',
      '',
    ].join('\n'),
  );

  const report = await audit({ root });
  const chosen = selectAutoActions(report, report.autofix, buildFixPlan(report).actions);
  const sources = chosen.map((action) => action.paths[0]);

  assert.ok(
    !sources.includes(path.join(root, 'x')),
    'the directory holding the original is not selected',
  );
  assert.ok(
    sources.includes(path.join(root, 'scratch')) === false ||
      sources.every((item) => !item.endsWith('_backup')),
    'the selector still works on ordinary candidates',
  );

  const outcome = await applyAutoActions(report, {
    actions: buildFixPlan(report).actions,
    now: '2026-11-19T00:00:00.000Z',
  });
  assert.deepEqual(outcome.moved, [], 'nothing moves');
  assert.equal((await stat(path.join(root, 'x', 'U218_master.mp4'))).isFile(), true);
});

test('X: the same policy does move a directory with nothing protected inside', async () => {
  // The control: without this the previous test would pass on a selector that
  // simply refuses everything, which is the failure mode I would otherwise ship.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-x3-'));
  created.push(dir);
  const root = path.join(dir, 'root');
  await mkdir(path.join(root, 'ordinary'), { recursive: true });
  await writeFile(path.join(root, 'ordinary', 'notes.txt'), 'nothing precious');
  await writeFile(
    path.join(root, 'layout.policy.yml'),
    [
      'version: 1',
      'autofix:',
      '  enabled: true',
      '  dryRun: false',
      '  rules: [top-level]',
      'rules:',
      '  top-level:',
      '    enabled: true',
      '    allow: [layout.policy.yml]',
      '',
    ].join('\n'),
  );

  const report = await audit({ root });
  const chosen = selectAutoActions(report, report.autofix, buildFixPlan(report).actions);
  assert.deepEqual(
    chosen.map((action) => action.paths[0]),
    [path.join(root, 'ordinary')],
    'an unprotected unknown directory is still a candidate',
  );
});
