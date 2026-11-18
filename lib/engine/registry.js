/**
 * Registry loading: the declaration of "big files that are allowed to be big".
 *
 * A missing registry is treated as an empty declaration, not an error, so a new
 * workspace can run the audit and then be told what to register.
 */

import { readFile } from 'node:fs/promises';

import { parseYaml, isPlainObject } from './policy.js';

/**
 * Read and normalise `layout.registry.yml`.
 *
 * @param {object} options
 * @param {string} options.registryPath Absolute path.
 * @returns {Promise<{ path: string, present: boolean, version: number, entries: object[] }>}
 */
export async function loadRegistry(options) {
  const registryPath = options.registryPath;
  let text;
  try {
    text = await readFile(registryPath, 'utf8');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return { path: registryPath, present: false, version: 1, entries: [] };
    }
    throw err;
  }

  const parsed = await parseYaml(text);
  const doc = isPlainObject(parsed) ? parsed : {};
  const rawEntries = Array.isArray(doc.entries) ? doc.entries : [];
  const entries = [];

  for (const raw of rawEntries) {
    if (!isPlainObject(raw)) continue;
    if (typeof raw.path !== 'string' || raw.path.trim() === '') continue;
    entries.push({
      path: raw.path.trim().replace(/^\.\//, ''),
      bytes: toNumber(raw.bytes),
      purpose: typeof raw.purpose === 'string' ? raw.purpose : '',
      externalizable: raw.externalizable === true,
      protected: raw.protected === true,
      note: typeof raw.note === 'string' ? raw.note : '',
    });
  }

  const version = Number.isFinite(Number(doc.version)) ? Math.floor(Number(doc.version)) : 1;
  return { path: registryPath, present: true, version, entries };
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
