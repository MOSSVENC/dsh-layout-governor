/**
 * The watcher is the difference between "a tool you remember to run" and "a thing
 * that notices". These tests pin the two properties that matter: it ignores work
 * that cannot have changed the tree, and a burst of writes costs one refresh.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createChangeWatcher, isMutatingTool } from '../lib/host/watcher.js';

/**
 * A timer harness that fires only when the test says so.
 * @returns {{ setTimer: Function, clearTimer: Function, run: () => void, armed: () => number }}
 */
function timers() {
  let queue = new Map();
  let nextId = 1;
  return {
    setTimer(fn) {
      const id = nextId;
      nextId += 1;
      queue.set(id, fn);
      return id;
    },
    clearTimer(id) {
      queue.delete(id);
    },
    run() {
      const pending = [...queue.values()];
      queue = new Map();
      for (const fn of pending) fn();
    },
    armed() {
      return queue.size;
    },
  };
}

test('mutating tools are recognised, including scoped names', () => {
  for (const name of ['write', 'edit', 'bash', 'pwsh', 'terminal', 'apply_patch', 'subagent']) {
    assert.equal(isMutatingTool(name), true, `${name} can change the tree`);
  }
  assert.equal(isMutatingTool('write:workspace'), true);
  for (const name of ['layout_audit', 'read', 'grep', 'glob', 'todo_write', '', undefined, null]) {
    assert.equal(isMutatingTool(name), false, `${String(name)} cannot change the tree`);
  }
});

test('a burst of writes collapses into one refresh', () => {
  const clock = timers();
  const calls = [];
  const watcher = createChangeWatcher({
    debounceMs: 3000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: () => 1_700_000_000_000,
    onChange: (info) => calls.push(info),
  });

  assert.equal(watcher.notify('write'), true);
  assert.equal(watcher.notify('bash'), true);
  assert.equal(watcher.notify('edit'), true);
  assert.equal(clock.armed(), 1, 'each write replaces the pending timer');
  assert.equal(watcher.pending(), true);

  clock.run();

  assert.equal(calls.length, 1, 'three writes, one refresh');
  assert.equal(calls[0].reason, 'workspace-changed');
  assert.equal(watcher.pending(), false);
});

test('a non-mutating tool never arms a refresh', () => {
  const clock = timers();
  let fired = 0;
  const watcher = createChangeWatcher({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onChange: () => {
      fired += 1;
    },
  });

  assert.equal(watcher.notify('layout_audit'), false);
  assert.equal(watcher.notify('read'), false);
  assert.equal(clock.armed(), 0);
  clock.run();
  assert.equal(fired, 0);
});

test('dispose cancels an armed refresh and ignores later writes', () => {
  const clock = timers();
  let fired = 0;
  const watcher = createChangeWatcher({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onChange: () => {
      fired += 1;
    },
  });

  watcher.notify('bash');
  watcher.dispose();
  assert.equal(clock.armed(), 0);
  assert.equal(watcher.notify('bash'), false);
  clock.run();
  assert.equal(fired, 0);

  watcher.dispose();
});
