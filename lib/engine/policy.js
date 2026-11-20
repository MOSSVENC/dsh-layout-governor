/**
 * Policy loading and rule-config resolution.
 *
 * The parser is `yaml` when it happens to be installed, otherwise the bundled
 * `yaml-lite`. Both must yield the same object for our own policy files, which
 * is asserted by `test/policy.test.mjs`.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseYamlLite } from './yaml-lite.js';
import { sha256Hex } from './util.js';

const SEVERITIES = new Set(['fail', 'warn', 'info']);

/** File name the engine looks for when no policy path is given. */
const POLICY_FILENAME = 'layout.policy.yml';

/** How far up the tree discovery climbs before giving up. */
const MAX_ANCESTOR_DEPTH = 16;

/**
 * True when a path exists and is a file.
 * @param {string} candidate Absolute path.
 * @returns {Promise<boolean>}
 */
async function isFile(candidate) {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/**
 * Find the policy that governs a tree.
 *
 * An explicit path is used as given. Otherwise the search starts at the audit
 * root and climbs: auditing `studio/video/capture` should obey the workspace
 * policy at `studio/`, the same way `.git` and `.editorconfig` are found. Without
 * this, every subtree audit needs a flag, and a forgotten flag reads as
 * "compliant".
 *
 * @param {object} options
 * @param {string} options.root Absolute audit root.
 * @param {string} [options.explicitPath] Caller-supplied policy path.
 * @returns {Promise<{ path: string, present: boolean, inherited: boolean }>}
 */
export async function findPolicy(options) {
  const root = path.resolve(options.root);
  if (typeof options.explicitPath === 'string' && options.explicitPath.trim() !== '') {
    const explicit = path.resolve(options.explicitPath);
    return { path: explicit, present: await isFile(explicit), inherited: false };
  }
  let dir = root;
  for (let depth = 0; depth <= MAX_ANCESTOR_DEPTH; depth += 1) {
    const candidate = path.join(dir, POLICY_FILENAME);
    if (await isFile(candidate)) return { path: candidate, present: true, inherited: depth > 0 };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { path: path.join(root, POLICY_FILENAME), present: false, inherited: false };
}
const DEFAULTS_MARKER = 'dsh-layout-governor/defaults/v1';

/**
 * Load the optional `yaml` package once per process.
 *
 * @returns {Promise<((text: string) => unknown)|null>} `parse` from `yaml`, or `null`.
 */
export async function loadYamlParser() {
  try {
    const mod = await import('yaml');
    const parse = mod.parse ?? (mod.default && mod.default.parse);
    return typeof parse === 'function' ? parse.bind(mod.default ?? mod) : null;
  } catch {
    return null;
  }
}

/**
 * Parse YAML with the best parser available.
 *
 * @param {string} text Raw YAML.
 * @returns {Promise<unknown>} Parsed document.
 */
export async function parseYaml(text) {
  const parse = await loadYamlParser();
  if (parse) {
    try {
      return parse(text);
    } catch (err) {
      throw new Error(`policy parse error (yaml): ${err && err.message ? err.message : err}`);
    }
  }
  try {
    return parseYamlLite(text);
  } catch (err) {
    throw new Error(`policy parse error (yaml-lite): ${err && err.message ? err.message : err}`);
  }
}

/**
 * Read and parse a policy file.
 *
 * A missing file is not an error: the engine falls back to per-rule defaults so
 * a fresh workspace still audits. A file that exists but does not parse is an
 * error, because silently auditing with defaults could hide real problems.
 *
 * @param {object} options
 * @param {string} options.policyPath Absolute path.
 * @returns {Promise<{ path: string, present: boolean, sha256: string, version: number, doc: object }>}
 */
export async function loadPolicy(options) {
  const policyPath = options.policyPath;
  let text;
  try {
    text = await readFile(policyPath, 'utf8');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return {
        path: policyPath,
        present: false,
        sha256: sha256Hex(DEFAULTS_MARKER),
        version: 1,
        doc: {},
      };
    }
    throw err;
  }

  const parsed = await parseYaml(text);
  if (parsed !== null && parsed !== undefined && !isPlainObject(parsed)) {
    throw new Error('policy parse error: top level must be a mapping');
  }
  const doc = parsed ?? {};
  return {
    path: policyPath,
    present: true,
    sha256: sha256Hex(text),
    version: normalizeVersion(doc.version),
    doc,
  };
}

/**
 * Merge policy rule blocks over rule defaults and apply the run-level switches.
 *
 * `allRulesOff` is the negative control: it must be able to turn a red tree
 * green, proving findings come from rules and not from constants.
 *
 * @param {object} doc Parsed policy document.
 * @param {Array<{ id: string, defaults: object }>} ruleDefs Rule modules in report order.
 * A missing policy file disables everything. Auditing an ungoverned directory
 * with built-in defaults would be a guess, not governance: the plugin must stay
 * silent until a workspace actually declares its layout.
 *
 * @param {object} [options]
 * @param {boolean} [options.allRulesOff]
 * @param {readonly string[]} [options.onlyRules]
 * @param {boolean} [options.policyPresent] `false` when the policy file is absent.
 * @returns {Map<string, object>} Resolved config per rule id.
 */
export function resolveRuleConfigs(doc, ruleDefs, options = {}) {
  const rawRules = isPlainObject(doc.rules) ? doc.rules : {};
  const onlyRules = Array.isArray(options.onlyRules) ? options.onlyRules.filter(Boolean) : [];
  const configs = new Map();

  for (const def of ruleDefs) {
    const raw = isPlainObject(rawRules[def.id]) ? rawRules[def.id] : {};
    const declared = isPlainObject(rawRules[def.id]);
    const config = { ...def.defaults, ...raw };

    // A rule runs when the policy names it. Declaring `duplicates` should not
    // silently switch on the other six with their defaults: what the file says is
    // what happens, and a partial policy is still a policy.
    let enabled = normalizeEnabled(raw.enabled, declared);
    if (options.policyPresent === false) enabled = false;
    if (options.allRulesOff === true) enabled = false;
    if (onlyRules.length > 0 && !onlyRules.includes(def.id)) enabled = false;

    config.enabled = enabled;
    config.severity = SEVERITIES.has(raw.severity) ? raw.severity : def.defaults.severity;
    configs.set(def.id, config);
  }

  return configs;
}

/**
 * Normalise the policy's `autofix` block.
 *
 * The engine only *reports* this setting; a Host decides whether to act on it. That
 * keeps `audit()` read-only while letting a workspace opt into self-healing for the
 * one reversible action class.
 *
 * @param {object} doc Parsed policy document.
 * @returns {{ enabled: boolean, dryRun: boolean, kinds: string[], rules: string[], maxPerRun: number }}
 */
export function resolveAutofix(doc) {
  const raw = isPlainObject(doc.autofix) ? doc.autofix : {};
  const kinds = stringList(raw.kinds);
  const rules = stringList(raw.rules);
  return {
    enabled: raw.enabled === true,
    dryRun: raw.dryRun !== false,
    // Only reversible classes are ever auto-applied, whatever the policy asks for.
    kinds: (kinds.length > 0 ? kinds : ['move-to-archive']).filter((kind) => kind === 'move-to-archive'),
    // Only rules whose findings are *about placement discipline*. A `top-level`
    // finding can be a directory someone created five minutes ago; sweeping that
    // into the archive automatically is not self-healing, it is data loss.
    rules: rules.length > 0 ? rules : ['backups'],
    maxPerRun: Number.isFinite(Number(raw.maxPerRun)) ? Math.max(1, Math.floor(Number(raw.maxPerRun))) : 20,
  };
}

/**
 * Normalise the policy's classification block.
 *
 * @param {object} doc Parsed policy document.
 * @returns {{ regenerable: string[], protected: string[] }} Pattern lists.
 */
export function resolveClassification(doc) {
  const raw = isPlainObject(doc.classification) ? doc.classification : {};
  return {
    regenerable: stringList(raw.regenerable),
    protected: stringList(raw.protected),
  };
}

/**
 * Normalise the global ignore list.
 *
 * @param {object} doc Parsed policy document.
 * @returns {string[]} Glob patterns.
 */
export function resolveIgnore(doc) {
  return stringList(doc.ignore);
}

/**
 * Convert a value into a list of non-empty strings.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item !== '');
}

/**
 * Convert a value into a plain non-array object.
 *
 * @param {unknown} value
 * @returns {object}
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeVersion(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function normalizeEnabled(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['false', 'no', 'off', '0', 'disabled'].includes(lowered)) return false;
    if (['true', 'yes', 'on', '1', 'enabled'].includes(lowered)) return true;
  }
  return fallback;
}
