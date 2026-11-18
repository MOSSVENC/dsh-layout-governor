/**
 * Rule `docs` must read the map, not the history.
 *
 * A rename table inside a fenced block says "quill/ used to exist". Treating it
 * as a claim reports every retired name forever, which makes the whole audit
 * easy to dismiss. The unfenced claims next to it must still be enforced, so the
 * fence stripping cannot be allowed to silence real drift.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { audit } from '../lib/engine/index.js';

const POLICY = `version: 1
rules:
  docs:
    enabled: true
    severity: fail
    file: README.md
    ignore: []
`;

const README_WITH_FENCE = `# Map

| directory | what |
|---|---|
| \`writings/\` | the writing line |

## Renamed

\`\`\`
quill/   -> writings/writer
miner/   -> mining/worker
\`\`\`

## Rules

\`raw/\` is immutable.
`;

const README_WITH_STALE_CLAIM = `# Map

\`writings/\` is the writing line, \`anvil/\` is the game line.
`;

const created = [];

after(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Build a throwaway tree with one directory and one README.
 * @param {string} readme README contents.
 * @returns {Promise<string>} the tree root.
 */
async function tree(readme) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lg-docs-'));
  created.push(root);
  await mkdir(path.join(root, 'writings'));
  await writeFile(path.join(root, 'README.md'), readme);
  await writeFile(path.join(root, 'layout.policy.yml'), POLICY);
  return root;
}

test('a fenced rename table is history, not a claim', async () => {
  const root = await tree(README_WITH_FENCE);
  const report = await audit({ root });
  const docs = report.findings.filter((item) => item.rule === 'docs');

  const claims = docs.map((item) => item.evidence?.claim).filter(Boolean);
  assert.deepEqual(
    claims.filter((claim) => claim === 'quill/' || claim === 'miner/'),
    [],
    'quill/ and miner/ must not be reported as missing top-level directories',
  );
  // `raw/` is claimed outside the fence and does not exist: that one still fires,
  // which proves stripping fences did not disable the rule.
  assert.ok(
    docs.some((item) => item.evidence?.claim === 'raw/'),
    'an unfenced claim must still be reported',
  );
});

test('an unfenced stale claim is still a failure', async () => {
  const root = await tree(README_WITH_STALE_CLAIM);
  const report = await audit({ root });
  const stale = report.findings.filter((item) => item.evidence?.claim === 'anvil/');

  assert.equal(stale.length, 1);
  assert.equal(stale[0].severity, 'fail');
  assert.match(stale[0].title, /anvil/);
});

test('fence stripping keeps unclaimed directories visible', async () => {
  const root = await tree(README_WITH_FENCE);
  await mkdir(path.join(root, 'wool'));
  const report = await audit({ root });
  const unclaimed = report.findings.filter((item) => item.evidence?.claim === null);

  assert.deepEqual(
    unclaimed.map((item) => item.evidence.name),
    ['wool'],
  );
});
