/**
 * Policy loading and rule-config resolution.
 *
 * The parser is `yaml` when it happens to be installed, otherwise the bundled
 * `yaml-lite`. Both must yield the same object for our own policy files, which
 * is asserted by `test/policy.test.mjs`.
 */

import { readFile } from 'node:fs/promises';

import { parseYamlLite } from './yaml-lite.js';
import { sha256Hex } from './util.js';

const SEVERITIES = new Set(['fail', 'warn', 'info']);
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
    const config = { ...def.defaults, ...raw };

    let enabled = normalizeEnabled(raw.enabled, true);
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
export function stringList(value) {
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
