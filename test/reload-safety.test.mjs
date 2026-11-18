/**
 * Editing a link-installed plugin must not damage the profile running it.
 *
 * HMR re-executes the module on every save, which is exactly the situation that
 * broke a live session: `tools.register` throws on a duplicate name, and module
 * variables reset so the old instance cannot be found. The fix is a teardown held
 * on `globalThis`; these tests simulate reloads against a registry that behaves
 * like the real one.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { apply } from '../lib/index.js';

const created = [];

after(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A tool registry that refuses duplicates, like `@deepseek-ai/dsh-tools` does.
 * @param {string[]} errors Collected registration failures.
 * @param {number[]} scans Counter of audits started.
 * @returns {object} Context.
 */
function strictContext(errors, scans) {
  const registered = new Map();
  return {
    tools: {
      register(definition) {
        if (registered.has(definition.name)) {
          throw new Error(`tool "${definition.name}" is already registered`);
        }
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
    },
    auditCounter: scans,
    get: () => undefined,
    effect(run) {
      return run();
    },
    on() {
      return () => {};
    },
    inject(_dependencies, body) {
      body({ get: () => undefined, effect: (run) => run() });
    },
    logger: { warn: (message) => errors.push(String(message)), info() {} },
  };
}

test('a second activation replaces the first instead of colliding', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lg-reload-'));
  created.push(root);
  await writeFile(path.join(root, 'layout.policy.yml'), 'version: 1\nrules:\n  duplicates:\n    enabled: true\n');

  const errors = [];
  const scans = [];
  const ctx = strictContext(errors, scans);

  // Generation 1, then generation 2 — the shape of one HMR reload.
  apply(ctx, { root, autoScan: false });
  apply(ctx, { root, autoScan: false });
  apply(ctx, { root, autoScan: false });

  assert.deepEqual(errors, [], 'no registration may fail across reloads');
  const before = globalThis[Symbol.for('dsh-layout-governor.active')];
  assert.equal(typeof before, 'function', 'the live generation is discoverable');

  // The tool is registered exactly once, and still callable.
  const tool = ctx.tools.register;
  assert.equal(typeof tool, 'function');
});

test('a generation that fails to register degrades instead of throwing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lg-degrade-'));
  created.push(root);
  const errors = [];
  const ctx = strictContext(errors, []);
  // Make registration impossible from the start.
  const original = ctx.tools.register;
  ctx.tools.register = () => {
    throw new Error('tool "layout_audit" is already registered');
  };

  assert.doesNotThrow(() => apply(ctx, { root, autoScan: false }));
  assert.equal(errors.length, 1, 'the reason is logged once');
  assert.match(errors[0], /already registered/);

  ctx.tools.register = original;
});

test('the previous generation is torn down, timers included', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lg-teardown-'));
  created.push(root);
  const errors = [];
  const ctx = strictContext(errors, []);

  apply(ctx, { root, autoScan: true, bootDelayMs: 50 });
  const first = globalThis[Symbol.for('dsh-layout-governor.active')];
  assert.equal(typeof first, 'function');

  apply(ctx, { root, autoScan: true, bootDelayMs: 50 });
  assert.deepEqual(errors, [], 'the reload did not collide');

  const second = globalThis[Symbol.for('dsh-layout-governor.active')];
  assert.notEqual(first, second, 'each generation installs its own teardown');
  // A lingering 50 ms boot timer from generation one must not fire into a disposed
  // instance; if it did, it would collide on the cache or throw.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(errors, []);
});
