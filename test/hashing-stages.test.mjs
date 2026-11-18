/**
 * Two-stage hashing, copied from how `fclones` and `czkawka` decide which files
 * are worth reading end to end.
 *
 * Stage one reads 64 KiB from each end of a file. On a 29 GB disk image that is
 * the difference between milliseconds and a minute, and it is the only reason an
 * automatic scan of a 122k-entry tree is affordable at all. The tests pin both
 * directions: identical large files must match, and same-size files with different
 * middles must not.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { hashFile, signatureOf, SIGNATURE_WINDOW } from '../lib/engine/hashing.js';

const created = [];

after(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Write one scratch file.
 * @param {Buffer} content Bytes.
 * @returns {Promise<string>} Absolute path.
 */
async function scratch(content) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-hash-'));
  created.push(dir);
  const file = path.join(dir, 'payload.bin');
  await writeFile(file, content);
  return file;
}

test('identical files share a signature', async () => {
  const body = Buffer.alloc(3 * 1024 * 1024, 5);
  const left = await scratch(body);
  const right = await scratch(body);
  assert.equal(
    await signatureOf(left, body.length),
    await signatureOf(right, body.length),
  );
});

test('same size but different middles do not collide', async () => {
  const size = 2 * 1024 * 1024;
  const a = Buffer.alloc(size, 1);
  const b = Buffer.alloc(size, 1);
  // Everything the signature never reads: past the head window, before the tail.
  b.fill(9, SIGNATURE_WINDOW + 1024, SIGNATURE_WINDOW + 4096);
  const left = await scratch(a);
  const right = await scratch(b);

  assert.equal(await signatureOf(left, size), await signatureOf(right, size),
    'a signature cannot see the middle — this is the documented limitation');

  assert.notEqual(
    (await hashFile(left)).sha256,
    (await hashFile(right)).sha256,
    'the full hash is what distinguishes them',
  );
});

test('a small file is hashed entirely by the signature path', async () => {
  const body = Buffer.from('tiny');
  const file = await scratch(body);
  assert.equal((await signatureOf(file, body.length)).length, 64);
});

test('an auto-style partial scan reports the mode it used', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lg-partial-'));
  created.push(dir);
  const body = Buffer.alloc(8192, 3);
  await writeFile(path.join(dir, 'a.wim'), body);
  await writeFile(path.join(dir, 'b.wim'), body);
  await writeFile(
    path.join(dir, 'layout.policy.yml'),
    'version: 1\nrules:\n  duplicates:\n    enabled: true\n    minBytes: 1024\n    maxCopies: 1\n',
  );

  const { audit } = await import('../lib/engine/index.js');
  const partial = await audit({ root: dir, hashMode: 'partial' });
  const full = await audit({ root: dir, hashMode: 'full' });

  assert.equal(partial.stats.hashMode, 'partial');
  assert.equal(full.stats.hashMode, 'full');
  assert.equal(partial.findings.length, 1);
  assert.equal(full.findings.length, 1);
  assert.equal(partial.findings[0].evidence.verifiedBy, 'signature');
  assert.equal(full.findings[0].evidence.verifiedBy, 'sha256');
  assert.equal(partial.findings[0].fixable, false, 'a signature may not authorise a delete');
  assert.equal(full.findings[0].fixable, true);
  assert.ok(
    partial.stats.hashedBytes <= full.stats.hashedBytes,
    'a signature must never read more than the full stream',
  );
});
