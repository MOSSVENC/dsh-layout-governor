/**
 * Small shared helpers: byte formatting, stable ids, path normalisation and
 * shell quoting. Kept dependency-free so the engine stays runnable from a bare
 * checkout with no install step.
 */

import { createHash } from 'node:crypto';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/**
 * Format a byte count as a short human string (base 1024).
 *
 * @param {number} bytes
 * @param {number} [digits] Decimal places for units above bytes.
 * @returns {string} For example `3.1 GB`.
 */
export function formatBytes(bytes, digits = 1) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/**
 * Hex sha256 of a string or Buffer.
 *
 * @param {string|Buffer} input
 * @returns {string} Lowercase hex digest.
 */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Build a stable finding id: `<rule>:<6 hex of key>`.
 *
 * The key is hashed so ids stay stable across runs and machines while staying
 * short enough to read in a report.
 *
 * @param {string} rule Rule id.
 * @param {string} key Stable identity of the finding (paths, glob, hash…).
 * @returns {string}
 */
export function findingId(rule, key) {
  return `${rule}:${sha256Hex(key).slice(0, 6)}`;
}

/**
 * Convert an OS path to a POSIX-ish relative path usable by globs.
 *
 * @param {string} rel
 * @returns {string}
 */
export function toPosix(rel) {
  return rel.split('\\').join('/');
}

/**
 * Strip trailing slashes so `a/` and `a` compare equal.
 *
 * @param {string} value
 * @returns {string}
 */
export function trimSlashes(value) {
  return String(value).replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Quote a value for safe interpolation into a single POSIX shell command.
 *
 * The fix plan must never produce a command that silently does something else
 * because a path contained a space, quote or `$`.
 *
 * @param {string} value
 * @returns {string} For example `'a b'`.
 */
export function shellQuote(value) {
  return `'${String(value).split("'").join("'\\''")}'`;
}

/**
 * Throw the signal's abort reason when the caller cancelled the audit.
 *
 * @param {AbortSignal|undefined} signal
 * @returns {void}
 */
export function checkAborted(signal) {
  if (signal && signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    const err = new Error('audit aborted');
    err.name = 'AbortError';
    throw err;
  }
}

/**
 * Round a duration to a non-negative integer.
 *
 * @param {number} value Milliseconds.
 * @returns {number}
 */
export function roundMs(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

/**
 * Coerce a configuration count, falling back when the value is unusable.
 *
 * YAML gives back strings, booleans, and nulls for the same key depending on how
 * a human typed it; every rule needs the same forgiving coercion, so it lives in
 * one place instead of being copied per rule.
 *
 * @param {unknown} value Candidate from the policy document.
 * @param {number} fallback Value used when the candidate is not a finite number >= 0.
 * @returns {number}
 */
export function toCount(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
