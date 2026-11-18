/**
 * Kill safety and filesystem safety.
 *
 * Two promises the engine makes to the host: a cancelled audit throws a clean
 * abort (no half-written report, no dangling work), and the walk never follows a
 * directory symlink — so a loop cannot hang the process and a link cannot drag
 * the audit outside the root.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildFixture } from '../fixtures/build.mjs';
import { audit } from '../lib/engine/index.js';

function isAbort(err) {
  return err && (err.name === 'AbortError' || /abort/i.test(String(err.message)));
}

test('an already-aborted signal rejects before touching the tree', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-kill-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const fixture = await buildFixture('clean', dir);

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    audit({
      root: fixture.root,
      policyPath: fixture.policyPath,
      registryPath: fixture.registryPath,
      signal: controller.signal,
    }),
    isAbort,
  );
});

test('aborting mid-walk rejects cleanly without writing anything', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-kill-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const root = path.join(dir, 'tree');
  const bulk = path.join(root, 'writings', 'bulk');
  await mkdir(bulk, { recursive: true });
  for (let i = 0; i < 400; i += 1) {
    await writeFile(path.join(bulk, `file-${String(i).padStart(3, '0')}.md`), `# ${i}\n`);
  }
  const before = (await readdir(bulk)).length;

  const controller = new AbortController();
  const pending = audit({ root, signal: controller.signal });
  setImmediate(() => controller.abort());

  await assert.rejects(pending, isAbort);

  const after = (await readdir(bulk)).length;
  assert.equal(after, before, 'the engine must not add or remove files');
  const topLevel = await readdir(root);
  assert.deepEqual(topLevel, ['writings']);
});

test('directory symlinks are not followed and never escape the root', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-kill-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const fixture = await buildFixture('symlink-loop', dir);
  const outside = path.join(path.dirname(fixture.root), 'outside');

  const report = await audit({
    root: fixture.root,
    policyPath: fixture.policyPath,
    registryPath: fixture.registryPath,
  });

  assert.equal(report.stats.symlinks, 3);

  for (const entry of report.findings.flatMap((finding) => finding.paths)) {
    assert.ok(entry.startsWith(fixture.root + path.sep), `${entry} escaped the audit root`);
  }

  // The loop back to the tree root must be recorded once and never descended.
  const loopEntries = report.composition.topLevel.filter((item) => item.name === 'writings');
  assert.equal(loopEntries.length, 1);
  assert.ok(report.stats.entries < 40, `walk should stay small, got ${report.stats.entries}`);
  assert.equal(report.stats.directories, 2);

  // The pristine tree is untouched, and the outside directory was never counted.
  const names = await readdir(fixture.root);
  assert.deepEqual(names.sort(), ['README.md', 'mining', 'writings']);
  assert.equal(report.findings.some((finding) => finding.paths.some((p) => p.startsWith(outside))), false);
});

test('a broken symlink is recorded, not fatal', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-kill-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const fixture = await buildFixture('symlink-loop', dir);

  const report = await audit({
    root: fixture.root,
    policyPath: fixture.policyPath,
    registryPath: fixture.registryPath,
  });

  assert.ok(report.stats.entries > 0);
  assert.equal(report.overall, 'pass');
  assert.deepEqual(report.counts, { fail: 0, warn: 0, info: 0 });
});
