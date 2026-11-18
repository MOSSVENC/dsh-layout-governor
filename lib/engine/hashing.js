/**
 * Content hashing with a bounded worker pool, in two stages.
 *
 * Stage one is a **signature**: the first and last 64 KiB of a file. Stage two is
 * the full stream. This is how `fclones` and `czkawka` decide which files are
 * worth reading end to end: a 29 GB disk image and its copy share a head and a
 * tail, and comparing 128 KiB decides that in milliseconds instead of reading
 * 58 GB. On a 122k-entry tree that is the difference between an automatic scan
 * you can leave running and one that saturates the disk.
 *
 * The two stages are not interchangeable evidence: a signature match means
 * "almost certainly identical", a full hash means "proven". Callers must label
 * which one they used, and this module never pretends otherwise.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';

/** Bytes read from each end of a file for a stage-one signature. */
export const SIGNATURE_WINDOW = 64 * 1024;

/**
 * Read a byte range without streaming the whole file.
 *
 * @param {string} absPath Absolute file path.
 * @param {number} start Offset.
 * @param {number} length Bytes to read.
 * @returns {Promise<Buffer>}
 */
async function readRange(absPath, start, length) {
  const handle = await open(absPath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(Math.max(0, length));
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

/**
 * Stage one: hash the head and the tail of a file.
 *
 * @param {string} absPath Absolute file path.
 * @param {number} size File size in bytes.
 * @param {number} [window] Bytes per end.
 * @returns {Promise<string>} Signature digest.
 */
export async function signatureOf(absPath, size, window = SIGNATURE_WINDOW) {
  const hash = createHash('sha256');
  const head = await readRange(absPath, 0, Math.min(window, size));
  hash.update(head);
  if (size > window) {
    const tailStart = Math.max(window, size - window);
    const tail = await readRange(absPath, tailStart, size - tailStart);
    hash.update(tail);
  }
  return hash.digest('hex');
}

/**
 * Stage two: hash the whole file, streaming.
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
      if (signal !== undefined && signal.aborted === true) {
        throw new Error('audit aborted');
      }
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
 * @param {number} [options.concurrency] Parallel operations; defaults to 4.
 * @param {'partial'|'full'} [options.mode] Stage one only, or the full stream.
 * @param {number} [options.window] Signature window in bytes.
 * @param {AbortSignal} [options.signal]
 * @returns {{
 *   hash: (absPath: string, size?: number) => Promise<{sha256: string, bytes: number}|null>,
 *   hashAll: (files: Array<{path: string, size: number}>) => Promise<Map<string, {sha256: string, bytes: number}>>,
 *   mode: 'partial'|'full',
 *   stats: () => { hashedFiles: number, hashedBytes: number },
 * }}
 */
export function createHashPool(options = {}) {
  const requested = Number(options.concurrency);
  const concurrency = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 4;
  const mode = options.mode === 'partial' ? 'partial' : 'full';
  const window = Number.isFinite(options.window) && options.window > 0 ? options.window : SIGNATURE_WINDOW;
  const signal = options.signal;
  const cache = new Map();
  let hashedFiles = 0;
  let hashedBytes = 0;

  /**
   * Hash one file, deduplicating concurrent and repeated requests.
   * @param {string} absPath Absolute path.
   * @param {number} [size] Known size, required for a signature.
   * @returns {Promise<{sha256: string, bytes: number}|null>} Digest, or null when unreadable.
   */
  function hash(absPath, size) {
    const key = `${mode}\u0000${absPath}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const pending = (async () => {
      try {
        if (mode === 'partial' && Number.isFinite(size)) {
          const digest = await signatureOf(absPath, size, window);
          hashedFiles += 1;
          // Bytes actually read: one window, or two when the file is long enough to
          // have a tail. A file smaller than the window is read once, in full.
          hashedBytes += size <= window ? size : window * 2;
          return { sha256: digest, bytes: size };
        }
        const result = await hashFile(absPath, signal);
        hashedFiles += 1;
        hashedBytes += result.bytes;
        return result;
      } catch (error) {
        if (signal !== undefined && signal.aborted === true) throw error;
        return null;
      }
    })();
    cache.set(key, pending);
    return pending;
  }

  /**
   * Hash every file in a bounded pool.
   * @param {Array<{ path: string, size: number }>} files Candidates.
   * @returns {Promise<Map<string, {sha256: string, bytes: number}>>} Digest per path.
   */
  async function hashAll(files) {
    const out = new Map();
    const queue = files.slice();
    let cursor = 0;
    const width = Math.max(1, Math.min(concurrency, queue.length));

    async function worker() {
      while (cursor < queue.length) {
        if (signal !== undefined && signal.aborted === true) throw new Error('audit aborted');
        const file = queue[cursor];
        cursor += 1;
        const result = await hash(file.path, file.size);
        if (result !== null) out.set(file.path, result);
      }
    }

    await Promise.all(Array.from({ length: width }, worker));
    return out;
  }

  return { hash, hashAll, mode, stats: () => ({ hashedFiles, hashedBytes }) };
}
