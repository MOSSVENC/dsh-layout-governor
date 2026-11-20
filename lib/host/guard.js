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

/** Copy and move shapes: the destination is a new path just as often as mkdir's. */
const COPY_RULES = [
  // `install -d <dir>` takes one argument and creates directories; the two-argument
  // form is a copy, so both shapes are covered.
  /(?:^|[\s;&|])install\s+-d\s+(?:-[a-zA-Z]+\s+)*([^-\s;&|][^\s;&|]*)/g,
  /(?:^|[\s;&|])cp\s+(?:-[a-zA-Z]+\s+)*([^-\s;&|][^\s;&|]*)\s+([^-\s;&|][^\s;&|]*)/g,
  /(?:^|[\s;&|])mv\s+(?:-[a-zA-Z]+\s+)*([^-\s;&|][^\s;&|]*)\s+([^-\s;&|][^\s;&|]*)/g,
  /(?:^|[\s;&|])install\s+(?:-[a-zA-Z]+\s+)*([^-\s;&|][^\s;&|]*)\s+([^-\s;&|][^\s;&|]*)/g,
  /(?:^|[\s;&|])rsync\s+(?:-[a-zA-Z]+\s+)*([^-\s;&|][^\s;&|]*)\s+([^-\s;&|][^\s;&|]*)/g,
];

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
 * Strip the parts of a shell command that are data, not commands.
 *
 * A heredoc body or a quoted string may contain `mkdir` as prose; treating it as a
 * command is exactly the false block this plugin exists to avoid. Only executable
 * text is scanned.
 *
 * @param {string} command Raw command line.
 * @returns {string} Command without quoted spans or heredoc bodies.
 */
export function sanitizeCommand(command) {
  const kept = [];
  let heredoc = null;

  for (const line of command.split('\n')) {
    if (heredoc !== null) {
      if (line.trim() === heredoc) heredoc = null;
      continue;
    }
    const marker = /<<[-~]?(?:'([^']*)'|"([^"]*)"|(\S+))/.exec(line);
    if (marker !== null) {
      heredoc = marker[1] ?? marker[2] ?? marker[3];
      kept.push(line.slice(0, marker.index));
      continue;
    }
    kept.push(line);
  }

  return kept.join('\n').replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ').replace(/`[^`]*`/g, ' ');
}

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
  }

  if (base === 'apply_patch' && typeof args?.patch === 'string') {
    // A patch names its files in the body, not in an argument.
    const added = /\*\*\* (?:Add|Update) File:\s*(.+?)\s*$/gm;
    let match = added.exec(args.patch);
    while (match !== null) {
      found.push(match[1].trim());
      match = added.exec(args.patch);
    }
  }

  if (!SHELL_TOOLS.has(base)) return found;
  const raw = typeof args?.command === 'string' ? args.command : typeof args?.text === 'string' ? args.text : '';
  if (raw === '') return found;

  // Split into commands so `cd elsewhere && <verb> x` resolves x where the shell
  // would, instead of at the session root.
  let cwd = null;
  for (const segment of sanitizeCommand(raw).split(/&&|\|\||;|\n/)) {
    const cd = /^\s*cd\s+(.+?)\s*$/.exec(segment);
    if (cd !== null) {
      // A relative cd continues from the previous one; `cd poc4` after
      // `cd /tmp/x` means /tmp/x/poc4, and the earlier version treated "poc4" as a
      // new top-level directory of the workspace.
      const target = cd[1].trim();
      if (target.startsWith('~')) cwd = target;
      else if (path.isAbsolute(target)) cwd = target;
      else if (cwd !== null && path.isAbsolute(cwd)) cwd = path.join(cwd, target);
      else cwd = null;
      continue;
    }

    for (const rule of CREATION_RULES) {
      rule.lastIndex = 0;
      let match = rule.exec(segment);
      while (match !== null) {
        const candidate = match[1]?.trim();
        if (isPathLike(candidate)) found.push(joinBase(cwd, candidate));
        match = rule.exec(segment);
      }
    }

    for (const rule of COPY_RULES) {
      rule.lastIndex = 0;
      let match = rule.exec(segment);
      while (match !== null) {
        // Two-argument forms name the destination second; `install -d` names it first.
        const destination = (match[2] ?? match[1])?.trim();
        if (isPathLike(destination)) found.push(joinBase(cwd, destination));
        match = rule.exec(segment);
      }
    }
  }
  return found;
}

/**
 * Whether a shell token is worth resolving as a path.
 * @param {string|undefined} token Token from a command.
 * @returns {boolean}
 */
function isPathLike(token) {
  if (token === undefined || token === '') return false;
  if (token === '/' || token.startsWith('-')) return false;
  if (token.startsWith('>') || token.startsWith('<')) return false;
  // Shell expansions cannot be resolved before the shell runs them.
  if (/[$*?{}()]/.test(token)) return false;
  if (token === '/dev/null' || token.startsWith('/dev/')) return false;
  // File-descriptor redirections (`2>&1`, `3>file`) and background ampersands are
  // syntax, not paths.
  if (/^[\d&]/.test(token) || token.includes('&')) return false;
  return true;
}

/**
 * Resolve a relative shell argument against the directory the shell is in.
 * @param {string|null} cwd Directory from an earlier `cd`, or null.
 * @param {string} candidate Raw token.
 * @returns {string} A path `path.resolve` can finish.
 */
function joinBase(cwd, candidate) {
  if (cwd === null || path.isAbsolute(candidate) || candidate.startsWith('~')) return candidate;
  return path.join(cwd, candidate);
}

/**
 * Create the pre-execute guard.
 *
 * @param {object} options
 * @param {(session?: unknown) => string} options.root The workspace root to police.
 * @param {() => { allow: string[], allowPatterns: string[], ignore: string[], enabled: boolean }} options.policy
 * @param {(session: unknown) => string} [options.baseOf] Session directory, for relative paths.
 * @returns {(exec: object, next: () => Promise<object>) => Promise<object>} Waterfall listener.
 */
export function createWriteGuard(options) {
  return async function guard(exec, next) {
    try {
      const settings = options.policy();
      if (settings.enabled !== true) return next();

      // Per session, not per activation: the root a tool call lands in is the
      // session's workspace, and a plugin-wide default is a guess.
      const root = path.resolve(options.root(exec?.agent?.session));
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
