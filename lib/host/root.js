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
 * Resolve the tree to audit.
 * @param {{ get: (name: string) => unknown }} ctx Registrant context.
 * @param {object} config Bundle row config.
 * @param {unknown} requested Caller-supplied root, if any.
 * @returns {string} An absolute path.
 */
export function resolveRoot(ctx, config, requested) {
  if (typeof requested === 'string' && requested.trim() !== '') return path.resolve(requested);
  const configured = typedField(config, 'root', 'string');
  if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured);
  try {
    const workingDirectory = ctx.get('workingDirectory');
    const fallback = workingDirectory?.defaultDirectory;
    if (typeof fallback === 'string' && fallback !== '') return path.resolve(fallback);
  } catch {
    // The service is optional; the process directory is a valid last resort.
  }
  return process.cwd();
}
