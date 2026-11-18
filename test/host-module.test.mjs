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
      return run();
    },
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
  apply(ctx, config);
  return { ctx, tools, routes };
}

test('the host exposes one tool and one route', () => {
  const { tools, routes } = harness();
  assert.equal(name, 'layout-governor');
  assert.deepEqual(inject, ['tools']);
  assert.equal(tools.length, 1);
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
  // Nothing was removed: the audit is read-only.
  const { readdir } = await import('node:fs/promises');
  assert.equal((await readdir(root)).length, 4);
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
