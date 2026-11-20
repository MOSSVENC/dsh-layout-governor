/**
 * The gate exists for the complaint that started this: the agent inventing new
 * top-level directories and files until the workspace is uncategorised. Everything
 * here is about *not* being too clever: deny only what is new, only at the root,
 * and fail open when the policy cannot be read.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { candidatePaths, createWriteGuard, guardSettings, sanitizeCommand } from '../lib/host/guard.js';
import { createIntentGuard, denyReason, targetPath } from '../lib/host/guard-fs.js';

const created = [];

after(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A guard bound to a throwaway workspace.
 * @param {string[]} allow Declared top-level entries.
 * @param {string} [existing] A directory to create before the guard runs.
 * @returns {Promise<{ root: string, guard: Function }>}
 */
async function guardFor(allow, existing) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lg-guard-'));
  created.push(root);
  if (existing !== undefined) await mkdir(path.join(root, existing), { recursive: true });
  await mkdir(path.join(root, allow[0] ?? 'keep'), { recursive: true });
  const guard = createWriteGuard({
    root: () => root,
    baseOf: () => root,
    policy: () => guardSettings({ rules: { 'top-level': { allow } } }),
  });
  return { root, guard };
}

const allow = (next) => ({ kind: 'allow' }) || next;

/**
 * Run one decision.
 * @param {Function} guard Guard.
 * @param {object} exec Tool execution stub.
 * @returns {Promise<object>} Decision.
 */
const decide = (guard, exec) => guard(exec, async () => ({ kind: 'allow' }));

test('a new top-level directory is denied, whether made by file or shell', async () => {
  const { root, guard } = await guardFor(['game']);
  const viaFile = await decide(guard, {
    name: 'write',
    arguments: { file_path: path.join(root, '乱建', 'x.md') },
  });
  assert.equal(viaFile.kind, 'deny');
  assert.match(viaFile.reason, /not a declared top-level entry/);

  const viaShell = await decide(guard, {
    name: 'bash',
    arguments: { command: `mkdir -p ${path.join(root, '临时')}` },
  });
  assert.equal(viaShell.kind, 'deny');
});

test('work inside a declared or existing directory is never blocked', async () => {
  const { root, guard } = await guardFor(['game', 'writings'], '_context');
  for (const target of [
    path.join(root, 'game', 'deep', 'new', 'file.gd'),
    path.join(root, 'writings', 'x.md'),
    path.join(root, '_context', 'x.md'),
  ]) {
    assert.equal((await decide(guard, { name: 'write', arguments: { file_path: target } })).kind, 'allow');
  }
});

test('paths outside the workspace are not this guard’s business', async () => {
  const { root, guard } = await guardFor(['game']);
  assert.equal(
    (await decide(guard, { name: 'write', arguments: { file_path: '/tmp/elsewhere/x.md' } })).kind,
    'allow',
  );
});

test('an unreadable policy fails open', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lg-guard-open-'));
  created.push(root);
  const guard = createWriteGuard({
    root: () => root,
    policy: () => {
      throw new Error('policy gone');
    },
  });
  assert.equal(
    (await decide(guard, { name: 'write', arguments: { file_path: path.join(root, 'x.md') } })).kind,
    'allow',
  );
});

test('guard: enabled false turns the gate off', async () => {
  const { root, guard } = await guardFor(['game']);
  const settings = guardSettings({ guard: { enabled: false }, rules: { 'top-level': { allow: ['game'] } } });
  const off = createWriteGuard({ root: () => root, policy: () => settings });
  assert.equal(
    (await decide(off, { name: 'write', arguments: { file_path: path.join(root, '乱建', 'x.md') } })).kind,
    'allow',
  );
});

test('shell parsing finds mkdir, touch and redirection targets', () => {
  assert.deepEqual(candidatePaths('bash', { command: 'mkdir -p a/b && touch c.md' }), ['a/b', 'c.md']);
  assert.deepEqual(candidatePaths('bash', { command: 'echo hi > notes.txt' }), ['notes.txt']);
  assert.deepEqual(candidatePaths('bash', { command: 'echo hi >> logs/x.log' }), ['logs/x.log']);
  assert.deepEqual(candidatePaths('read', { file_path: 'x' }), [], 'read-only tools are ignored');
});

test('data that merely mentions a command is not a command', () => {
  // Found on the live host: a heredoc body containing `mkdir` was read as a mkdir,
  // so writing a script was blocked. Only executable text is scanned.
  const v = 'mk' + 'dir';
  const command = `cat > /tmp/x.sh <<'EOF'\n${v} -p /tmp/zzz\nEOF`;
  assert.deepEqual(candidatePaths('bash', { command }), ['/tmp/x.sh']);
  assert.equal(sanitizeCommand(command).includes(v), false);

  assert.deepEqual(candidatePaths('bash', { command: `echo "${v} -p /tmp/zzz"` }), []);
});

test('a relative command resolves where cd put it', () => {
  const v = 'mk' + 'dir';
  assert.deepEqual(candidatePaths('bash', { command: `cd /tmp && ${v} work` }), ['/tmp/work']);
  assert.deepEqual(candidatePaths('bash', { command: `${v} work` }), ['work']);
});

test('copying into a new directory is a creation too', () => {
  const target = '/tmp/zzz_new';
  for (const command of [
    `cp a.txt ${target}/`,
    `mv a.txt ${target}/`,
    `rsync -a src/ ${target}/`,
    `install -d ${target}`,
  ]) {
    // Same directory either way; `install -d` simply has no slash to keep.
    const found = candidatePaths('bash', { command });
    assert.equal(found.length, 1, command);
    assert.equal(found[0].replace(/\/$/, ''), target, command);
  }
});

test('a patch body names the files it adds', () => {
  assert.deepEqual(candidatePaths('apply_patch', { patch: '*** Add File: /tmp/zzz/f.md\n+x' }), [
    '/tmp/zzz/f.md',
  ]);
});

test('shell expansions and devices are not resolved as paths', () => {
  assert.deepEqual(candidatePaths('bash', { command: 'echo x > $HOME/file' }), []);
  assert.deepEqual(candidatePaths('bash', { command: 'echo x > /dev/null' }), []);
  assert.deepEqual(candidatePaths('bash', { command: 'echo x > 2>&1' }), []);
});

test('the file service refuses the same new top-level entry', async () => {
  // The command gate only sees tool arguments; every writer resolves through the
  // file service, so this is where a scripted write is caught.
  const root = await mkdtemp(path.join(os.tmpdir(), 'lg-intent-'));
  created.push(root);
  await mkdir(path.join(root, 'game'), { recursive: true });
  const settings = guardSettings({ rules: { 'top-level': { allow: ['game'] } } });

  assert.equal(denyReason({ path: path.join(root, 'game', 'deep', 'x.md'), root, settings }), null);
  assert.equal(denyReason({ path: '/tmp/elsewhere/x.md', root, settings }), null);

  const reason = denyReason({ path: path.join(root, '新目录', 'x.md'), root, settings });
  assert.match(String(reason), /not a declared top-level entry/);

  const guard = createIntentGuard({ root: () => root, policy: () => settings });
  assert.throws(() => guard({ path: path.join(root, '新目录', 'x.md') }, {}), /layout policy:/);
  assert.doesNotThrow(() => guard({ path: path.join(root, 'game', 'x.md') }, {}));
  assert.doesNotThrow(() => guard(null, {}), 'an unknown target shape must not fail a write');
});

test('an fs target is read from whichever field the service uses', () => {
  assert.equal(targetPath({ path: '/tmp/a' }), '/tmp/a');
  assert.equal(targetPath({ targetKey: '/tmp/b' }), '/tmp/b');
  assert.equal(targetPath('/tmp/c'), '/tmp/c');
  assert.equal(targetPath({}), null);
});
