/**
 * Which tree does "here" mean?
 *
 * Order: the caller's explicit request, the bundle row's configured root, the
 * session's default working directory, then the process directory. The fallbacks
 * exist because the tool is often called with no arguments from a session whose
 * working directory is the thing the user is actually asking about.
 */

import path from 'node:path';

/**
 * Read one optional configuration value with the expected primitive type.
 * @param {unknown} config The bundle row's raw config object.
 * @param {string} key Field name.
 * @param {'string'|'number'|'boolean'} type Expected `typeof` result.
 * @returns {unknown} The value, or `undefined` when absent or of the wrong type.
 */
export function typedField(config, key, type) {
  const value = config?.[key];
  return typeof value === type ? value : undefined;
}

/**
 * The session a call belongs to, when the caller has one.
 *
 * A tool call carries the agent whose session is asking; an HTTP route carries
 * none. That difference is the whole reason this module exists as a separate
 * function rather than two `??` expressions.
 */
export const NO_SESSION = Symbol('no session');

/**
 * Resolve the tree to audit.
 *
 * Order: explicit request → row config → the caller's session directory → the
 * open workspace → the process directory.
 *
 * The session step is the important one: `workingDirectory.defaultDirectory` is
 * the *host's* default, which is `$HOME` for the web process. Using it made the
 * panel audit `/home/mossvenc` while the user was looking at a workspace in
 * `/mnt/d/studio` — a plausible, wrong answer, which is the worst kind.
 *
 * @param {{ get: (name: string) => unknown }} ctx Registrant context.
 * @param {object} config Bundle row config.
 * @param {unknown} requested Caller-supplied root, if any.
 * @param {unknown} [session] Session the call belongs to, or {@link NO_SESSION}.
 * @returns {string} An absolute path.
 */
export function resolveRoot(ctx, config, requested, session = NO_SESSION) {
  if (typeof requested === 'string' && requested.trim() !== '') return path.resolve(requested);
  const configured = typedField(config, 'root', 'string');
  if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured);

  if (session !== NO_SESSION && session !== null && session !== undefined) {
    try {
      const workingDirectory = ctx.get('workingDirectory');
      const fromSession = workingDirectory?.get?.(session);
      if (typeof fromSession === 'string' && fromSession !== '') return path.resolve(fromSession);
    } catch {
      // Fall through to the workspace registry.
    }
  }

  try {
    // The route has no session, so it asks which workspace is open instead.
    const registry = ctx.get('workspaceRegistry');
    const workspaces = registry?.list?.();
    if (Array.isArray(workspaces) && workspaces.length > 0) {
      // The most recently touched workspace is the one the user is looking at.
      // Taking `list()[0]` made the panel audit `$HOME`, because the first
      // workspace in the registry happened to be the home directory.
      const newest = [...workspaces].sort((a, b) =>
        String(b?.updatedAt ?? '').localeCompare(String(a?.updatedAt ?? '')),
      )[0];
      if (typeof newest?.path === 'string' && newest.path !== '') return path.resolve(newest.path);
    }
  } catch {
    // Fall through to the process directory.
  }

  try {
    const workingDirectory = ctx.get('workingDirectory');
    const fallback = workingDirectory?.defaultDirectory;
    if (typeof fallback === 'string' && fallback !== '') return path.resolve(fallback);
  } catch {
    // The process directory is a valid last resort.
  }
  return process.cwd();
}
