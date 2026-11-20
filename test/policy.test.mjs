/**
 * The shipped policy and registry must parse, declare every field the engine
 * reads, and parse identically through both YAML paths.
 *
 * The `yaml` package is optional, so the comparison half is skipped when it is
 * not installed. `yaml-lite` is always exercised.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseYamlLite } from '../lib/engine/yaml-lite.js';
import { loadPolicy, resolveRuleConfigs, resolveClassification, resolveIgnore } from '../lib/engine/policy.js';
import { loadRegistry } from '../lib/engine/registry.js';
import { RULES } from '../lib/engine/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const policyPath = path.join(repoRoot, 'layout.policy.yml');
const registryPath = path.join(repoRoot, 'layout.registry.yml');

const RULE_IDS = ['top-level', 'backups', 'duplicates', 'families', 'large-files', 'docs', 'protected'];
const SEVERITIES = new Set(['fail', 'warn', 'info']);

async function tryYaml() {
  try {
    const mod = await import('yaml');
    return mod.parse ?? (mod.default && mod.default.parse) ?? null;
  } catch {
    return null;
  }
}

test('layout.policy.yml parses and declares the studio workspace', async () => {
  const text = await readFile(policyPath, 'utf8');
  const policy = parseYamlLite(text);

  assert.equal(policy.version, 1);
  assert.ok(Array.isArray(policy.ignore));
  assert.ok(policy.ignore.includes('**/node_modules/**'));
  assert.ok(policy.ignore.includes('**/.git/**'));

  for (const id of RULE_IDS) {
    const block = policy.rules[id];
    assert.ok(block, `rules.${id} is missing`);
    assert.equal(typeof block.enabled, 'boolean', `rules.${id}.enabled`);
    assert.ok(SEVERITIES.has(block.severity), `rules.${id}.severity`);
  }
  assert.deepEqual(Object.keys(policy.rules).sort(), [...RULE_IDS].sort());

  const allow = policy.rules['top-level'].allow;
  for (const name of [
    'writings',
    'mining',
    'video',
    'game',
    'wool',
    '_projects',
    '_tools',
    '_context',
    '_references',
    '_archive',
    '_backup',
    '_rescue_20261117',
    'README.md',
    'HANDOFF.md',
  ]) {
    assert.ok(allow.includes(name), `top-level allow is missing ${name}`);
  }
  assert.deepEqual(policy.rules['top-level'].allowPatterns, ['*.lock']);
  for (const name of ['layout.policy.yml', 'layout.registry.yml']) {
    assert.ok(
      policy.rules['top-level'].allow.includes(name),
      `top-level allow must permit ${name}, the governor's own inputs`,
    );
  }

  const backups = policy.rules.backups;
  assert.deepEqual(backups.allowedRoots, ['_archive']);
  assert.equal(backups.allowedNamePattern, '^[0-9]{8}_[a-z0-9_-]+$');
  assert.equal(backups.legacySymlinks, 'warn');
  for (const pattern of ['_backup', '_rescue_*', '*.bak.*', '*.bak', 'backup_*']) {
    assert.ok(backups.forbidNames.includes(pattern), `forbidNames is missing ${pattern}`);
  }

  assert.equal(policy.rules.duplicates.minBytes, 104857600);
  assert.equal(policy.rules.duplicates.maxCopies, 1);
  assert.deepEqual(policy.rules.families.groups, [{ match: '**/*.iso', maxPer: 2, groupBy: 'dir' }]);
  assert.equal(policy.rules['large-files'].minBytes, 1073741824);
  assert.equal(policy.rules['large-files'].registry, 'layout.registry.yml');
  assert.equal(policy.rules.docs.file, 'README.md');
  assert.deepEqual(policy.rules.docs.ignore, [
    '_rescue_*',
    '_backup',
    'raw',
    'quill',
    'miner',
    'lens',
    'anvil',
  ]);
  // Third-party trees are exempt per rule rather than by weakening the patterns.
  assert.deepEqual(policy.rules.backups.ignore, [
    '_tools/src/**',
    '_references/**',
    '_projects/**/upstream/**',
    '**/node_modules/**',
  ]);
  assert.deepEqual(policy.rules.families.ignore, ['_projects/**/upstream/**', '_references/**']);

  assert.deepEqual(policy.rules.protected.patterns, [
    'writings/writer/**',
    '**/U218*',
    '**/7705047215923976320*',
    '_context/dsbot_archive_20261117/**',
  ]);

  assert.deepEqual(policy.classification.regenerable, [
    '**/.venv/**',
    '**/node_modules/**',
    '**/iso_tree/**',
    '**/_scratch/**',
    '_tools/py312/**',
  ]);
  assert.deepEqual(policy.classification.protected, policy.rules.protected.patterns);
});

test('layout.policy.yml resolves into seven enabled rule configs', async () => {
  const loaded = await loadPolicy({ policyPath });
  assert.equal(loaded.present, true);
  assert.match(loaded.sha256, /^[0-9a-f]{64}$/);

  const configs = resolveRuleConfigs(loaded.doc, RULES, {});
  assert.equal(configs.size, 7);
  for (const rule of RULES) {
    const config = configs.get(rule.id);
    assert.equal(config.enabled, true, `${rule.id} should be enabled`);
    assert.ok(SEVERITIES.has(config.severity));
    for (const key of Object.keys(rule.defaults)) {
      assert.notEqual(config[key], undefined, `${rule.id}.${key} lost its default`);
    }
  }

  const hardOff = resolveRuleConfigs(loaded.doc, RULES, { allRulesOff: true });
  assert.ok([...hardOff.values()].every((config) => config.enabled === false));

  const notPresent = resolveRuleConfigs(loaded.doc, RULES, { policyPresent: false });
  assert.ok([...notPresent.values()].every((config) => config.enabled === false));

  assert.deepEqual(resolveIgnore(loaded.doc), [
    '**/node_modules/**',
    '**/.git/**',
    '**/.codegraph-wsl/**',
  ]);
  assert.equal(resolveClassification(loaded.doc).regenerable.length, 5);
});

test('layout.registry.yml parses and declares the real payloads', async () => {
  const loaded = await loadRegistry({ registryPath });
  assert.equal(loaded.present, true);
  assert.equal(loaded.version, 1);
  assert.ok(Array.isArray(loaded.entries));
  assert.ok(loaded.entries.length >= 2);

  for (const entry of loaded.entries) {
    assert.equal(typeof entry.path, 'string');
    assert.ok(entry.path.length > 0);
    assert.equal(typeof entry.bytes, 'number');
    assert.ok(entry.bytes > 0);
    assert.equal(typeof entry.purpose, 'string');
    assert.ok(entry.purpose.length > 0, `${entry.path} needs a purpose`);
    assert.equal(typeof entry.externalizable, 'boolean');
    assert.equal(typeof entry.protected, 'boolean');
    assert.equal(typeof entry.note, 'string');
  }

  const paths = loaded.entries.map((entry) => entry.path);
  assert.ok(paths.some((p) => p.endsWith('*.vhdx')), 'the 29 GB vhdx must be registered');
  assert.ok(paths.some((p) => p.endsWith('*.iso')), 'the ISO set must be registered');
  assert.equal(paths.some((p) => p.includes('.venv')), false, 'regenerable envs are not registered file by file');
});

test('yaml and yaml-lite agree on the shipped files', async (t) => {
  const parse = await tryYaml();
  if (!parse) {
    t.skip('optional `yaml` package is not installed; yaml-lite covered above');
    return;
  }

  const policyText = await readFile(policyPath, 'utf8');
  const registryText = await readFile(registryPath, 'utf8');
  assert.deepEqual(parse(policyText), parseYamlLite(policyText));
  assert.deepEqual(parse(registryText), parseYamlLite(registryText));
});

test('yaml and yaml-lite agree on inline sequences and mappings', async (t) => {
  const doc = [
    'version: 2',
    'ignore: ["**/a/**", "**/b/**"]',
    'meta: {owner: "studio", level: 3, on: true}',
    'flags:',
    '- "x"',
    '- "y"',
    'empty: []',
    'none:',
    'nested:',
    '  deep:',
    '    value: -12.5',
    '  list:',
    '    - 1',
    '    - 2',
    '',
  ].join('\n');

  const lite = parseYamlLite(doc);
  assert.deepEqual(lite.ignore, ['**/a/**', '**/b/**']);
  assert.deepEqual(lite.meta, { owner: 'studio', level: 3, on: true });
  assert.deepEqual(lite.flags, ['x', 'y']);
  assert.deepEqual(lite.empty, []);
  assert.equal(lite.none, null);
  assert.equal(lite.nested.deep.value, -12.5);
  assert.deepEqual(lite.nested.list, [1, 2]);

  const parse = await tryYaml();
  if (!parse) {
    t.skip('optional `yaml` package is not installed; yaml-lite covered above');
    return;
  }
  assert.deepEqual(parse(doc), lite);
});
