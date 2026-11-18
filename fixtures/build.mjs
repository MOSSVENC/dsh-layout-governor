/**
 * Fixture builder.
 *
 * Every fixture is generated on disk from this file — no binary payloads are
 * committed. Layout on disk:
 *
 *   <dir>/<name>/tree/                  <- the audit root
 *   <dir>/<name>/layout.policy.yml      <- policy tuned so only the target rule fires
 *   <dir>/<name>/layout.registry.yml    <- registry
 *
 * Policy and registry live OUTSIDE the audited root on purpose: a fixture must
 * be able to be "all green" without the audit config showing up as a stray
 * top-level entry.
 */

import { mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { SPECS, autoReadme, basePolicy, blob } from './specs.mjs';

/** Names accepted by `buildFixture`. */
export const FIXTURE_NAMES = [
  'clean',
  'duplicates',
  'duplicates-protected',
  'backup-location',
  'docs-drift',
  'families',
  'large-files',
  'protected-missing',
  'symlink-loop',
  'studio-mini',
];

const BASE_TIME = Date.UTC(2026, 10, 1, 12, 0, 0);
const DAY = 86400000;

/**
 * Serialise a fixture policy/registry document as YAML.
 *
 * Only maps, arrays and scalars are supported; that is all the policy schema
 * uses, and it keeps the fixture files readable diffs.
 *
 * @param {unknown} value
 * @param {number} [indent]
 * @returns {string}
 */
export function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    let out = '';
    for (const item of value) {
      if (isPlainObject(item)) {
        const body = toYaml(item, indent + 2).replace(new RegExp(`^${' '.repeat(indent + 2)}`), '');
        out += `${pad}- ${body.trimStart()}`;
      } else if (Array.isArray(item)) {
        out += `${pad}-\n${toYaml(item, indent + 2)}`;
      } else {
        out += `${pad}- ${scalar(item)}\n`;
      }
    }
    return out;
  }
  if (isPlainObject(value)) {
    let out = '';
    for (const [key, item] of Object.entries(value)) {
      if (Array.isArray(item)) {
        if (item.length === 0) out += `${pad}${key}: []\n`;
        else out += `${pad}${key}:\n${toYaml(item, indent + 2)}`;
        continue;
      }
      if (isPlainObject(item)) {
        if (Object.keys(item).length === 0) out += `${pad}${key}: {}\n`;
        else out += `${pad}${key}:\n${toYaml(item, indent + 2)}`;
        continue;
      }
      out += `${pad}${key}: ${scalar(item)}\n`;
    }
    return out;
  }
  return `${pad}${scalar(value)}\n`;
}

/**
 * Build one fixture tree, its policy and its registry.
 *
 * @param {string} name Fixture name from `FIXTURE_NAMES`.
 * @param {string} dir Parent directory (usually a fresh temp dir).
 * @returns {Promise<{ name: string, root: string, policyPath: string, registryPath: string, policy: object, registry: object, readme: string }>}
 */
export async function buildFixture(name, dir) {
  const spec = SPECS[name];
  if (!spec) throw new Error(`unknown fixture: ${name} (known: ${FIXTURE_NAMES.join(', ')})`);

  const base = path.join(dir, name);
  const root = path.join(base, 'tree');
  await rm(base, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  const built = spec(root, base);
  const policy = built.policy ?? basePolicy();
  const registry = built.registry ?? { version: 1, entries: [] };
  const readme = built.readme ?? autoReadme(built);

  for (const entry of built.files ?? []) {
    const abs = path.join(root, entry.rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, entry.content);
    const day = entry.day ?? 10;
    const stamp = new Date(BASE_TIME + day * DAY);
    await utimes(abs, stamp, stamp);
  }

  for (const rel of built.dirs ?? []) {
    await mkdir(path.join(root, rel), { recursive: true });
  }

  for (const link of built.symlinks ?? []) {
    const abs = path.join(root, link.rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await symlink(link.target, abs);
  }

  await writeFile(path.join(root, 'README.md'), readme);

  const policyPath = path.join(base, 'layout.policy.yml');
  const registryPath = path.join(base, 'layout.registry.yml');
  await writeFile(policyPath, `# generated fixture policy: ${name}\n${toYaml(policy)}`);
  await writeFile(registryPath, `# generated fixture registry: ${name}\n${toYaml(registry)}`);

  return { name, root, policyPath, registryPath, policy, registry, readme };
}

/**
 * Write an arbitrary policy document next to an existing fixture.
 *
 * @param {string} file Absolute target path.
 * @param {object} doc Policy document.
 * @returns {Promise<string>} The path written.
 */
export async function writePolicyFile(file, doc) {
  await writeFile(file, `# generated policy\n${toYaml(doc)}\n`);
  return file;
}

function scalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = String(value);
  if (text === '') return '""';
  const plainSafe = /^[A-Za-z0-9_][A-Za-z0-9_\-./]*$/.test(text);
  const reserved = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off']);
  if (plainSafe && !reserved.has(text.toLowerCase())) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value);
}
