/**
 * Minimal glob matcher for policy patterns.
 *
 * Supported syntax: `*` (no slash), `?` (one non-slash), `**` (any depth),
 * `[abc]` / `[a-z]` character classes. A trailing `/**` also matches the
 * directory itself, so `node_modules/**` covers both `node_modules` and
 * everything under it — that is what an ignore/protected pattern is expected
 * to mean in practice.
 *
 * Patterns are matched against slash-separated relative paths. A pattern with
 * no slash is matched against a single path segment (used for file/dir names).
 */

import { toPosix } from './util.js';

const cache = new Map();

/**
 * Compile a glob pattern into a RegExp anchored at both ends.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  const key = String(pattern);
  const hit = cache.get(key);
  if (hit) return hit;

  let src = toPosix(key).replace(/^\.\//, '');
  let tail = '';
  if (src === '**') {
    src = '';
    tail = '.*';
  } else if (src.endsWith('/**')) {
    src = src.slice(0, -3);
    tail = '(?:/.*)?';
  }

  let out = '';
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (ch === '*') {
      const double = src[i + 1] === '*';
      if (double) {
        const next = src[i + 2];
        if (next === '/') {
          out += '(?:[^/]+/)*';
          i += 3;
          continue;
        }
        out += '.*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }

    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }

    if (ch === '[') {
      const end = src.indexOf(']', i + 1);
      if (end === -1) {
        out += '\\[';
        i += 1;
        continue;
      }
      let body = src.slice(i + 1, end);
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      out += `[${body.replace(/\\/g, '\\\\')}]`;
      i = end + 1;
      continue;
    }

    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }

  const re = new RegExp(`^${out}${tail}$`);
  cache.set(key, re);
  return re;
}

/**
 * Test one relative path against one glob pattern.
 *
 * @param {string} relPath Slash-separated path relative to the audit root.
 * @param {string} pattern Glob pattern.
 * @returns {boolean}
 */
export function matchesGlob(relPath, pattern) {
  return globToRegExp(pattern).test(toPosix(relPath));
}

/**
 * Test one name (single segment, no slash) against one glob pattern.
 *
 * @param {string} name
 * @param {string} pattern
 * @returns {boolean}
 */
function matchesName(name, pattern) {
  return globToRegExp(pattern).test(String(name));
}

/**
 * True when any pattern matches the path.
 *
 * @param {string} relPath
 * @param {readonly string[]} [patterns]
 * @returns {boolean}
 */
export function matchesAny(relPath, patterns) {
  if (!patterns || patterns.length === 0) return false;
  for (const p of patterns) {
    if (matchesGlob(relPath, p)) return true;
  }
  return false;
}

/**
 * True when any pattern matches the name.
 *
 * @param {string} name
 * @param {readonly string[]} [patterns]
 * @returns {boolean}
 */
export function matchesAnyName(name, patterns) {
  if (!patterns || patterns.length === 0) return false;
  for (const p of patterns) {
    if (matchesName(name, p)) return true;
  }
  return false;
}

/**
 * A pattern is a glob when it contains any wildcard character.
 *
 * @param {string} pattern
 * @returns {boolean}
 */
export function isGlobPattern(pattern) {
  return /[*?[]/.test(String(pattern));
}
