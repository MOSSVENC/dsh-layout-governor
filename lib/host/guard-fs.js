import path from 'node:path';

import { existsSync } from 'node:fs';
import { matchesAnyName, matchesGlob } from '../engine/glob.js';

/**
 * The filesystem-level half of the gate.
 *
 * `tools/pre-execute` sees the tool call and its arguments; this sees the resolved
 * write target inside the file service, which every writer goes through — the
 * `write` tool, `apply_patch`, and any other caller of `fs.writeText`. A command
 * that writes through a script still bypasses both, but the surface is now the file
 * service rather than one tool's argument names.
 *
 * The rule is identical to the command gate's: only a first-level entry of the
 * workspace that does not exist yet may be refused. Everything else stays writable,
 * and an unreadable policy allows the write.
 */

/**
 * Pull an absolute path out of an fs target.
 *
 * @param {unknown} target FsTarget from the file service.
 * @returns {string|null} Absolute path, or null when the shape is unknown.
 */
export function targetPath(target) {
  if (typeof target === 'string') return target;
  if (target === null || typeof target !== 'object') return null;
  for (const field of ['path', 'absolutePath', 'targetKey', 'filePath', 'key']) {
    const value = target[field];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/**
 * Decide whether one resolved write target is acceptable.
 *
 * @param {object} options
 * @param {string} options.path Absolute write target.
 * @param {string} options.root Workspace root.
 * @param {{ enabled: boolean, allow: string[], allowPatterns: string[], ignore: string[] }} options.settings
 * @returns {string|null} A denial reason, or null when the write may proceed.
 */
export function denyReason({ path: target, root, settings }) {
  if (settings.enabled !== true) return null;
  const rel = path.relative(root, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;

  const first = rel.split(path.sep)[0];
  if (first === '') return null;
  if (settings.allow.some((entry) => entry === first)) return null;
  if (settings.allowPatterns.some((pattern) => matchesGlob(first, pattern))) return null;
  if (settings.ignore.some((pattern) => matchesAnyName(first, [pattern]))) return null;
  // Something that already exists is not a new mess; the audit reports it separately.
  if (existsSync(path.join(root, first))) return null;

  return (
    `layout policy: "${first}" is not a declared top-level entry of ${root}, and it does not ` +
    'exist yet. Put this under an existing domain directory, or add it to ' +
    'layout.policy.yml top-level.allow if it is a new permanent category.'
  );
}

/**
 * Create the file-service listeners.
 *
 * @param {object} options
 * @param {(actor: unknown) => string} options.root Resolver bound to the actor's session.
 * @param {() => { enabled: boolean, allow: string[], allowPatterns: string[], ignore: string[] }} options.policy
 * @returns {(target: unknown, actor: unknown) => void} Listener for `fs/*-intent`.
 */
export function createIntentGuard(options) {
  return function intentGuard(target, actor) {
    try {
      const settings = options.policy();
      if (settings.enabled !== true) return;
      const absolute = targetPath(target);
      if (absolute === null) return;
      const root = path.resolve(options.root(actor));
      const reason = denyReason({ path: path.resolve(absolute), root, settings });
      if (reason !== null) throw new Error(reason);
    } catch (error) {
      // The refusal must propagate; anything else (a shape we cannot read, a
      // policy that vanished) must not turn into a write failure.
      if (error instanceof Error && error.message.startsWith('layout policy:')) throw error;
    }
  };
}
