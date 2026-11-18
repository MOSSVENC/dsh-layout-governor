/**
 * Streaming sha256 with a bounded worker pool.
 *
 * Large media files are the whole point of this plugin, so nothing here reads a
 * file into memory: each hash is a `createReadStream` piped through
 * `createHash('sha256')` chunk by chunk.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { checkAborted } from './util.js';

/**
 * Hash one file without buffering it.
 *
 * @param {string} absPath Absolute file path.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ sha256: string, bytes: number }>}
 */
export async function hashFile(absPath, signal) {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = createReadStream(absPath);
  try {
    for await (const chunk of stream) {
      checkAborted(signal);
      hash.update(chunk);
      bytes += chunk.length;
    }
  } finally {
    stream.destroy();
  }
  return { sha256: hash.digest('hex'), bytes };
}

/**
 * Create a memoising, concurrency-limited hasher.
 *
 * @param {object} [options]
 * @param {number} [options.concurrency] Parallel streams; defaults to 4.
 * @param {AbortSignal} [options.signal]
 * @returns {{ hash: (absPath: string) => Promise<{sha256: string, bytes: number}|null>, hashAll: (absPaths: string[]) => Promise<Map<string, {sha256: string, bytes: number}>>, stats: () => { hashedFiles: number, hashedBytes: number } }}
 */
export function createHashPool(options = {}) {
  const requested = Number(options.concurrency);
  const concurrency = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 4;
  const signal = options.signal;
  const cache = new Map();
  let hashedFiles = 0;
  let hashedBytes = 0;

  function hash(absPath) {
    const hit = cache.get(absPath);
    if (hit) return hit;
    const pending = (async () => {
      try {
        const result = await hashFile(absPath, signal);
        hashedFiles += 1;
        hashedBytes += result.bytes;
        return result;
      } catch (err) {
        if (signal && signal.aborted) throw err;
        return null;
      }
    })();
    cache.set(absPath, pending);
    return pending;
  }

  async function hashAll(absPaths) {
    const out = new Map();
    const queue = absPaths.slice();
    let cursor = 0;
    const width = Math.max(1, Math.min(concurrency, queue.length));

    async function worker() {
      while (cursor < queue.length) {
        checkAborted(signal);
        const abs = queue[cursor];
        cursor += 1;
        const result = await hash(abs);
        if (result) out.set(abs, result);
      }
    }

    await Promise.all(Array.from({ length: width }, worker));
    return out;
  }

  return {
    hash,
    hashAll,
    stats: () => ({ hashedFiles, hashedBytes }),
  };
}
