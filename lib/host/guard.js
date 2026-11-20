/**
 * The gate that answers the original complaint: stop the agent from inventing
 * top-level files and directories in the first place.
 *
 * Everything else in this plugin looks at a tree after it changed. This module is
 * the only part that acts *before* a write lands, through the host's
 * `tools/pre-execute` waterfall: a tool call that is about to create a new
 * first-level entry the policy does not list is denied, with a reason the model can
 * act on.
 *
 * Scope, deliberately narrow:
 *   - only the workspace root's first level is policed, because that is what
 *     "the classification got messy" actually means; work inside a domain
 *     directory is the domain's business;
 *   - existing paths are never denied, so nothing that already works breaks;
 *   - shell commands are inspected for `mkdir`, `touch`, and output redirection,
 *     which are the ways a command can create the same mess the file tools can.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { matchesAnyName, matchesGlob } from '../engine/glob.js';

/** Tools whose arguments name one path directly. */
const FILE_TOOLS = new Map([
  ['write', ['file_path']],
  ['edit', ['file_path']],
  ['str_replace_editor', ['path']],
  ['apply_patch', ['file_path', 'path']],
]);

/** Shell tools whose command string may create paths. */
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'terminal', 'shell']);

/** Command shapes that can create a directory or a file. */
const CREATION_RULES = [
  /(?:^|[\s;&|])mkdir\s+(?:-[a-zA-Z]+\s+)*([^\s;&|]+)/g,
  /(?:^|[\s;&|])touch\s+(?:-[a-zA-Z]+\s+)*([^\s;&|]+)/g,
  /(?:^|[\s;&|])tee\s+(?:-[a-zA-Z]+\s+)*([^\s;&|]+)/g,
  /(?:^|[\s;&|])>>\s*([^\s;&|]+)/g,
  // `>` must not swallow the second character of `>>`, which produced a ">"
  // target that then looked like a directory name.
  /(?:^|[\s;&|])>(?!>)\s*([^\s;&|]+)/g,
];

/**
 * Pull candidate paths out of one tool call.
 *
 * @param {string} name Tool name.
 * @param {object} args Parsed arguments.
 * @returns {string[]} Raw path strings, unresolved.
 */
export function candidatePaths(name, args) {
  const base = String(name).split(':')[0];
  const found = [];

  const fields = FILE_TOOLS.get(base);
  if (fields !== undefined) {
    for (const field of fields) {
      const value = args?.[field];
      if (typeof value === 'string' && value.trim() !== '') found.push(value.trim());
    }
    return found;
  }

  if (!SHELL_TOOLS.has(base)) return found;
  const command = typeof args?.command === 'string' ? args.command : typeof args?.text === 'string' ? args.text : '';
  if (command === '') return found;

  for (const rule of CREATION_RULES) {
    rule.lastIndex = 0;
    let match = rule.exec(command);
    while (match !== null) {
      const candidate = match[1]?.trim();
      if (
        candidate !== undefined &&
        candidate !== '' &&
        candidate !== '/' &&
        !candidate.startsWith('-') &&
        !candidate.startsWith('>') &&
        !candidate.startsWith('<')
      ) {
        found.push(candidate);
      }
      match = rule.exec(command);
    }
  }
  return found;
}

/**
 * Create the pre-execute guard.
 *
 * @param {object} options
 * @param {() => string} options.root The workspace root to police.
 * @param {() => { allow: string[], allowPatterns: string[], ignore: string[], enabled: boolean }} options.policy
 * @param {(session: unknown) => string} [options.baseOf] Session directory, for relative paths.
 * @returns {(exec: object, next: () => Promise<object>) => Promise<object>} Waterfall listener.
 */
export function createWriteGuard(options) {
  return async function guard(exec, next) {
    try {
      const settings = options.policy();
      if (settings.enabled !== true) return next();

      const root = path.resolve(options.root());
      const base = options.baseOf?.(exec?.agent?.session) ?? root;
      const candidates = candidatePaths(exec?.name, exec?.arguments ?? {});
      if (candidates.length === 0) return next();

      for (const candidate of candidates) {
        const absolute = path.resolve(base, candidate);
        const rel = path.relative(root, absolute);
        // Anything outside the workspace is somebody else's tree.
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
        const first = rel.split(path.sep)[0];
        if (first === '') continue;
        if (settings.allow.some((entry) => entry === first)) continue;
        if (settings.allowPatterns.some((pattern) => matchesGlob(first, pattern))) continue;
        if (settings.ignore.some((pattern) => matchesAnyName(first, [pattern]))) continue;
        // A directory that already exists is not a new mess: the audit reports it,
        // the gate must not freeze work inside it.
        if (existsSync(path.join(root, first))) continue;
        return {
          kind: 'deny',
          reason:
            `layout policy: "${first}" is not a declared top-level entry of ${root}, and it does not ` +
            'exist yet. Put this under an existing domain directory, or add it to ' +
            'layout.policy.yml top-level.allow if it is a new permanent category.',
        };
      }
    } catch {
      // A guard that throws must never block a tool call: failing open is the only
      // safe direction for a pre-dispatch hook.
    }
    return next();
  };
}

/**
 * Read the guard settings out of a policy document.
 *
 * @param {object} doc Parsed policy.
 * @returns {{ enabled: boolean, allow: string[], allowPatterns: string[], ignore: string[] }}
 */
export function guardSettings(doc) {
  const raw = typeof doc?.guard === 'object' && doc.guard !== null ? doc.guard : {};
  const top = typeof doc?.rules === 'object' && doc.rules?.['top-level'] ? doc.rules['top-level'] : {};
  const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
  return {
    enabled: raw.enabled !== false,
    // The top-level allow list is the vocabulary of the workspace; the guard is the
    // enforcement of it, not a second list to keep in sync.
    allow: list(top.allow),
    allowPatterns: list(top.allowPatterns),
    ignore: [...list(top.ignore), ...list(raw.ignore)],
  };
}
