/**
 * Integration test for the Host half.
 *
 * The plugin's two public surfaces are the `layout_audit` tool and the panel
 * route, and both are thin wrappers over the engine. This test drives them
 * through the real registration path — a recording context instead of Cordis —
 * against a throwaway tree, so a change that breaks the wiring fails here instead
 * of in a session.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { apply, inject, name } from '../lib/index.js';
import { budgetText, RULE_IDS } from '../lib/host/audit-tool.js';

const POLICY = `version: 1
ignore: []
rules:
  top-level:
    enabled: false
  backups:
    enabled: false
  duplicates:
    enabled: true
    minBytes: 1024
    maxCopies: 1
  families:
    enabled: false
  large-files:
    enabled: false
  docs:
    enabled: false
  protected:
    enabled: false
`;

const created = [];

after(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Build a tree with three byte-identical payloads and a policy that only checks
 * for duplicates.
 * @returns {Promise<string>} the tree root.
 */
async function dirtree() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lg-host-'));
  created.push(root);
  const payload = Buffer.alloc(4096, 7);
  await mkdir(path.join(root, 'writings'));
  await mkdir(path.join(root, 'mining'));
  await writeFile(path.join(root, 'writings', 'install.wim'), payload);
  await writeFile(path.join(root, 'mining', 'install.wim'), payload);
  await writeFile(path.join(root, 'install-copy.wim'), payload);
  await writeFile(path.join(root, 'layout.policy.yml'), POLICY);
  return root;
}

/**
 * Create a context that records tool definitions and exact routes.
 * @param {{ root?: string }} config Row config.
 * @returns {{ ctx: object, tools: object[], routes: object[] }}
 */
function harness(config = {}) {
  const tools = [];
  const routes = [];
  const listeners = [];
  const disposers = [];
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
    get() {
      return undefined;
    },
    effect(run) {
      const dispose = run();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    on(name, handler) {
      listeners.push({ name, handler });
      return () => {};
    },
    logger: { info() {}, warn() {} },
    inject(dependencies, body) {
      assert.deepEqual(dependencies, ['connection']);
      body({
        get() {
          return {
            fetch: {
              register(route) {
                routes.push(route);
                return () => {};
              },
            },
          };
        },
        effect(run) {
          return run();
        },
      });
    },
  };
  // Automatic behaviour is opt-in for the default harness: a background scan in
  // every wiring test would make them slow and order-dependent. The tests that
  // want it pass `autoScan: true` and a tiny delay.
  apply(ctx, { autoScan: false, ...config });
  /**
   * Deliver one finished tool call to every registered listener.
   * @param {string} toolName Tool name.
   */
  const emitToolResult = (toolName) => {
    for (const entry of listeners) {
      if (entry.name === 'tools/result') entry.handler({ name: toolName }, { isError: false });
    }
  };
  return { ctx, tools, routes, listeners, disposers, emitToolResult };
}

test('the host exposes one tool and one route', () => {
  const { tools, routes } = harness();
  assert.equal(name, 'layout-governor');
  assert.deepEqual(inject, ['tools']);
  assert.equal(tools.length, 2, 'an audit tool and an index query tool');
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['layout_audit', 'layout_query']);
  assert.equal(tools[0].name, 'layout_audit');
  assert.equal(tools[0].parameters.type, 'object');
  assert.ok(Array.isArray(tools[0].parameters.properties.rule.items.enum));
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/api/layout-governor/report');
  assert.deepEqual(routes[0].methods, ['POST']);
});

test('the tool reports duplicates and renders text', async () => {
  const root = await dirtree();
  const { tools } = harness();
  const tool = tools[0];

  const value = await tool.execute({ root }, { signal: undefined });

  assert.equal(value.ok, true);
  assert.equal(value.overall, 'fail');
  assert.equal(value.counts.fail, value.findings.length);
  assert.equal(value.findings.length, 1);
  assert.equal(value.findings[0].rule, 'duplicates');
  assert.equal(value.findings[0].severity, 'fail');
  assert.equal(value.findings[0].paths.length, 3);
  assert.match(value.text, /duplicates/);

  // The output schema is enforced by the registry, so the value must satisfy it.
  for (const key of tool.output.schema.required) {
    assert.ok(key in value, `output is missing required key ${key}`);
  }
  const blocks = tool.output.render({ root }, value);
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[0].text, value.text);
});

test('fixPlan appends a reviewable script without running it', async () => {
  const root = await dirtree();
  const { tools } = harness();
  const value = await tools[0].execute({ root, fixPlan: true }, {});

  assert.match(value.text, /```bash/);
  assert.match(value.text, /set -eu/);
  // Nothing was removed: the audit is read-only. The one new file is the index the
  // audit writes beside the tree, which the walker skips so it never audits itself.
  const { readdir } = await import('node:fs/promises');
  const onDisk = await readdir(root);
  assert.equal(onDisk.length, 5);
  assert.deepEqual(onDisk.filter((name) => name.startsWith('.layout-index')), ['.layout-index.db']);
});

test('the panel route answers with the same report', async () => {
  const root = await dirtree();
  const { routes } = harness();
  const request = new Request('http://local/api/layout-governor/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root }),
  });

  const response = await routes[0].fetch(request);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.value.overall, 'fail');
  assert.equal(payload.value.counts.fail, 1);
  assert.ok(payload.value.fixPlan, 'the panel needs the fix plan for its hint line');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('the route reports an engine failure instead of throwing', async () => {
  const { routes } = harness();
  const request = new Request('http://local/api/layout-governor/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: '/definitely/not/a/directory' }),
  });

  const response = await routes[0].fetch(request);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'layout-governor/scan-failed');
  assert.match(payload.error.message, /ENOENT|no such file|not a directory/i);
});

test('the tool refuses a root that does not exist', async () => {
  const { tools } = harness();
  await assert.rejects(
    () => tools[0].execute({ root: '/definitely/not/a/directory' }, {}),
    /ENOENT|no such file|not a directory/i,
  );
});

test('a profile without a connection channel still registers the tool', () => {
  const tools = [];
  const ctx = {
    tools: { register: (definition) => tools.push(definition) },
    get: () => undefined,
    effect: (run) => run(),
    inject: (_dependencies, body) => body({ get: () => undefined, effect: (run) => run() }),
  };
  apply(ctx, {});
  assert.equal(tools.length, 2, 'neither tool depends on the web channel');
});

test('the row config sets the root and the cache lifetime', async () => {
  const root = await dirtree();
  const { tools } = harness({ root, cacheMs: 0 });
  const tool = tools[0];

  const first = await tool.execute({}, {});
  const second = await tool.execute({}, {});

  assert.equal(first.overall, 'fail', 'an empty root argument falls back to the row config');
  assert.equal(second.overall, 'fail', 'cacheMs 0 forces a fresh scan, not a stale verdict');
  assert.notEqual(first, second);
});

test('the model-facing text is budgeted at a line boundary', () => {
  const short = 'line one\nline two';
  assert.equal(budgetText(short, 1000), short);

  const long = `${'x'.repeat(50)}\n`.repeat(40);
  const cut = budgetText(long, 120);
  assert.ok(cut.length < long.length);
  assert.match(cut, /report truncated \(\d+ chars\)/);
  assert.ok(!cut.includes('xxxxx…'), 'a cut never happens mid-line');
  assert.ok(cut.split('\n')[0].length === 50, 'whole lines survive');
});

test('the advertised rule filter matches the engine registry', () => {
  assert.deepEqual(RULE_IDS, [
    'top-level',
    'backups',
    'duplicates',
    'families',
    'large-files',
    'docs',
    'protected',
  ]);
});

/**
 * Wait for background work to settle.
 * @param {number} ms Milliseconds.
 * @returns {Promise<void>}
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a finished write triggers a background rescan', async () => {
  const root = await dirtree();
  // autoScan on (so the watcher is installed), but the activation scan parked far
  // enough away that only the tool result can explain a refresh.
  const { tools, emitToolResult } = harness({
    root,
    autoScan: true,
    bootDelayMs: 5_000,
    watchDebounceMs: 5,
    cacheMs: 60_000,
  });
  const tool = tools[0];

  const before = await tool.execute({ root }, {});
  assert.equal(before.findings.length, 1);

  // A second identical trio appears on disk.
  const payload = Buffer.alloc(4096, 9);
  await writeFile(path.join(root, 'writings', 'second.wim'), payload);
  await writeFile(path.join(root, 'mining', 'second.wim'), payload);
  await writeFile(path.join(root, 'second-copy.wim'), payload);

  // Nothing has noticed yet: the report is cached and correct as of its own time.
  const stale = await tool.execute({ root }, {});
  assert.equal(stale.findings.length, 1, 'without a trigger the cached report stands');

  emitToolResult('write');
  await delay(80);

  const fresh = await tool.execute({ root }, {});
  assert.equal(fresh.findings.length, 2, 'the write armed one debounced rescan');
});

test('a read-only tool does not trigger a rescan', async () => {
  const root = await dirtree();
  const { tools, emitToolResult } = harness({ root, watchDebounceMs: 5, cacheMs: 60_000 });
  const tool = tools[0];
  await tool.execute({ root }, {});

  const payload = Buffer.alloc(4096, 9);
  await writeFile(path.join(root, 'writings', 'second.wim'), payload);
  await writeFile(path.join(root, 'mining', 'second.wim'), payload);
  await writeFile(path.join(root, 'second-copy.wim'), payload);

  emitToolResult('read');
  emitToolResult('layout_audit');
  await delay(80);

  const still = await tool.execute({ root }, {});
  assert.equal(still.findings.length, 1, 'reading the tree does not change it');
});

test('activation scans before anyone asks', async () => {
  const root = await dirtree();
  const { tools } = harness({ root, autoScan: true, bootDelayMs: 5, cacheMs: 60_000 });
  await delay(80);

  // Disabling every rule would change the verdict — if the next call re-scanned.
  await writeFile(
    path.join(root, 'layout.policy.yml'),
    POLICY.replace("duplicates:\n    enabled: true", "duplicates:\n    enabled: false"),
  );

  const cached = await tools[0].execute({ root }, {});
  assert.equal(cached.findings.length, 1, 'the activation scan filled the cache first');

  const forced = await tools[0].execute({ root, force: true }, {});
  assert.equal(forced.findings.length, 0, 'a forced scan sees the new policy, proving the difference');
});

test('the disposers clean up the watcher and the boot timer', async () => {
  const root = await dirtree();
  const { disposers } = harness({ root, autoScan: true, bootDelayMs: 5 });
  await delay(30);
  assert.ok(disposers.length > 0);
  for (const dispose of disposers) dispose();
});

test('a busy session does not rescan on every write', async () => {
  const root = await dirtree();
  const { tools, emitToolResult } = harness({
    root,
    autoScan: true,
    bootDelayMs: 5_000,
    watchDebounceMs: 2,
    minRescanIntervalMs: 10_000,
    cacheMs: 60_000,
  });
  const tool = tools[0];

  const first = await tool.execute({ root }, {});
  assert.equal(first.findings.length, 1);

  // One write triggers a scan; further writes inside the floor must wait, not stack.
  emitToolResult('write');
  await delay(40);
  const afterFirst = await tool.execute({ root }, {});
  assert.equal(afterFirst.findings.length, 1);

  const payload = Buffer.alloc(4096, 9);
  await writeFile(path.join(root, 'writings', 'extra.wim'), payload);
  await writeFile(path.join(root, 'mining', 'extra.wim'), payload);
  await writeFile(path.join(root, 'extra-copy.wim'), payload);

  emitToolResult('write');
  emitToolResult('bash');
  emitToolResult('edit');
  await delay(60);

  const throttled = await tool.execute({ root }, {});
  assert.equal(
    throttled.findings.length,
    1,
    'inside minRescanIntervalMs the trigger waits instead of walking again',
  );
});
