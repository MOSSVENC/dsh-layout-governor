/**
 * The index is the fourth surface of this plugin — after the engine, the tool and
 * the panel — and the one an agent reads instead of walking a tree. Its three
 * promises are tested here: reopen cheap, unchanged files never re-read, and
 * queries answer from the store.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { audit, query } from '../lib/engine/index.js';
import { indexStats, lookupHash, openIndex, queryIndex, syncFiles } from '../lib/engine/store.js';

const created = [];

after(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A small governed tree plus its index path.
 * @returns {Promise<{ root: string, store: string }>}
 */
async function tree() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-store-'));
  created.push(dir);
  const root = path.join(dir, 'tree');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(root, 'writings'), { recursive: true });
  const body = Buffer.alloc(4096, 7);
  await writeFile(path.join(root, 'writings', 'a.wim'), body);
  await writeFile(path.join(root, 'writings', 'a-copy.wim'), body);
  await writeFile(
    path.join(root, 'layout.policy.yml'),
    'version: 1\nrules:\n  duplicates:\n    enabled: true\n    minBytes: 1024\n    maxCopies: 1\n',
  );
  return { root, store: path.join(dir, 'layout.db') };
}

test('reopening the index is idempotent', async () => {
  const { store } = await tree();
  openIndex(store).close();
  const db = openIndex(store);
  db.exec('SELECT 1');
  db.close();
});

test('a second audit reuses digests instead of re-reading files', async () => {
  const { root, store } = await tree();
  const first = await audit({ root, storePath: store });
  const second = await audit({ root, storePath: store });

  assert.ok(first.stats.hashedFiles > 0, 'the first run reads the files');
  assert.equal(second.stats.hashedFiles, 0, 'the second run reads none of them');
  assert.equal(second.stats.hashedBytes, 0);
  assert.equal(second.index.run, 2, 'both runs are recorded');
  assert.equal(second.findings.length, first.findings.length, 'and reach the same verdict');
});

test('a touched file is re-read', async () => {
  const { root, store } = await tree();
  await audit({ root, storePath: store });
  await writeFile(path.join(root, 'writings', 'a-copy.wim'), Buffer.alloc(4096, 9));

  const after_ = await audit({ root, storePath: store });
  assert.ok(after_.stats.hashedFiles > 0, 'a changed mtime invalidates the stored digest');
});

test('deleted paths leave the index', async () => {
  const { root, store } = await tree();
  await audit({ root, storePath: store });
  const { rm: remove } = await import('node:fs/promises');
  await remove(path.join(root, 'writings', 'a-copy.wim'));

  await audit({ root, storePath: store });
  const rows = query({ storePath: store, filters: { name: 'a-copy' } }).rows;
  assert.deepEqual(rows, [], 'the index never keeps a file that is gone');
});

test('queries answer from the index without walking', async () => {
  const { root, store } = await tree();
  await audit({ root, storePath: store });

  const big = query({ storePath: store, filters: { minSize: 1024 } });
  assert.ok(big.rows.length >= 1);
  assert.ok(big.rows.every((row) => row.size >= 1024));

  const byRule = query({ storePath: store, filters: { rule: 'duplicates' } });
  assert.equal(byRule.rows.length, 1, 'one path per finding, not one per run');
  assert.match(byRule.rows[0].path, /a\.wim|a-copy\.wim/);

  assert.equal(big.stats.files >= 2, true);
});

test('the latest run scopes findings, so repeated scans do not multiply answers', async () => {
  const { root, store } = await tree();
  await audit({ root, storePath: store });
  await audit({ root, storePath: store });
  await audit({ root, storePath: store });

  const db = openIndex(store);
  const stats = indexStats(db);
  assert.equal(stats.runs, 3);
  assert.ok(stats.findings >= 3, 'the history is kept');
  assert.equal(queryIndex(db, { rule: 'duplicates' }).length, 1, 'but a query answers about now');
  db.close();
});

test('syncFiles prunes rows for paths the walk no longer sees', async () => {
  const { store } = await tree();
  const db = openIndex(store);
  syncFiles(db, [
    { path: '/t/one', isFile: true, size: 1, mtimeMs: 1 },
    { path: '/t/two', isFile: true, size: 1, mtimeMs: 1 },
  ]);
  syncFiles(db, [{ path: '/t/one', isFile: true, size: 1, mtimeMs: 1 }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 1);
  db.close();
});

test('a stale index row is not trusted as a digest', async () => {
  const { store } = await tree();
  const db = openIndex(store);
  syncFiles(db, [{ path: '/t/x', isFile: true, size: 10, mtimeMs: 5 }], new Map([['/t/x', 'abc']]));
  assert.equal(lookupHash(db, '/t/x', 10, 5)?.hash, 'abc');
  assert.equal(lookupHash(db, '/t/x', 11, 5), null, 'size changed');
  assert.equal(lookupHash(db, '/t/x', 10, 6), null, 'mtime changed');
  db.close();
});
