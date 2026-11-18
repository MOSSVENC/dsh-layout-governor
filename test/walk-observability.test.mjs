/**
 * A partial audit must say that it was partial.
 *
 * The walker used to swallow an unreadable directory and report the rest as if it
 * were the whole tree, which turns "I could not look there" into "there is nothing
 * there". On a real workspace that is the difference between a user deleting
 * something and a user stopping to check.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { audit } from '../lib/engine/index.js';

const created = [];

after(async () => {
  await Promise.all(
    created.map(async (dir) => {
      // Restore traversal rights so the recursive removal can reach the fixture.
      await rm(path.join(dir, 'hidden'), { recursive: true, force: true }).catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }),
  );
});

/**
 * A tree with one readable and one unreadable directory.
 * @returns {Promise<{ root: string, hidden: string }>}
 */
async function tree() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lg-walk-'));
  created.push(root);
  await mkdir(path.join(root, 'visible'));
  await writeFile(path.join(root, 'visible', 'note.txt'), 'hello');
  const hidden = path.join(root, 'hidden');
  await mkdir(hidden);
  await writeFile(path.join(hidden, 'secret.txt'), 'x');
  await writeFile(path.join(root, 'layout.policy.yml'), 'version: 1\nrules:\n  duplicates:\n    enabled: true\n');
  return { root, hidden };
}

const canDropRead = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;

test('an unreadable directory is counted, not ignored', { skip: !canDropRead }, async () => {
  const { root, hidden } = await tree();
  const { chmod } = await import('node:fs/promises');
  await chmod(hidden, 0o000);
  try {
    const report = await audit({ root });
    assert.ok(
      report.stats.unreadable >= 1,
      `expected the unreadable directory to be counted, got ${report.stats.unreadable}`,
    );
    assert.ok(report.stats.entries >= 1, 'the readable part is still audited');
  } finally {
    await chmod(hidden, 0o755);
  }
});

test('a tree with no unreadable path reports zero', async () => {
  const { root, hidden } = await tree();
  await rm(hidden, { recursive: true, force: true });
  const report = await audit({ root });
  assert.equal(report.stats.unreadable, 0);
});
