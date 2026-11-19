/**
 * Short-lived report cache with in-flight de-duplication.
 *
 * A sidebar refresh and a tool call can land within milliseconds of each other,
 * and a cold scan of a 122k-entry tree costs ~35 s. Scanning twice is not a
 * correctness bug, it is a usability bug: whoever asks second waits for a second
 * full walk. This keeps the last few reports by key and, more importantly, makes
 * the second caller await the first caller's promise instead of starting its own.
 */

/** Reports kept in the freshness window. */
const DEFAULT_LIMIT = 8;

/** How long a report stays usable, in milliseconds. */
const DEFAULT_MAX_AGE_MS = 30_000;

/**
 * Create a report cache.
 *
 * @param {object} [options]
 * @param {number} [options.maxAgeMs] Freshness window; `0` disables reuse of finished reports.
 * @param {number} [options.limit] Reports retained.
 * @returns {{
 *   read: (key: string, produce: () => Promise<object>, options?: { force?: boolean }) => Promise<object>,
 *   size: () => number,
 *   clear: () => void,
 * }}
 */
export function createReportCache(options = {}) {
  const maxAgeMs =
    Number.isFinite(options.maxAgeMs) && options.maxAgeMs >= 0 ? options.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const limit =
    Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : DEFAULT_LIMIT;

  /** @type {Map<string, { at: number, report: object }>} */
  const finished = new Map();
  /** @type {Map<string, Promise<object>>} */
  const running = new Map();

  /**
   * Insert and evict in insertion order, so eviction is O(1).
   * @param {string} key Cache key.
   * @param {object} report Finished report.
   */
  function remember(key, report) {
    finished.delete(key);
    finished.set(key, { at: Date.now(), report });
    while (finished.size > limit) {
      const oldest = finished.keys().next();
      if (oldest.done === true) break;
      finished.delete(oldest.value);
    }
  }

  return {
    /**
     * Reuse a fresh report, join an in-flight scan, or produce a new one.
     * @param {string} key Cache key.
     * @param {() => Promise<object>} produce Scan to run when nothing is reusable.
     * @param {{ force?: boolean, accept?: (report: object) => boolean }} [readOptions]
     *   `accept` decides whether a cached report answers this request at all, which
     *   is how a bounded scan is kept from satisfying a deliberate one.
     * @returns {Promise<object>} The report.
     */
    async read(key, produce, readOptions = {}) {
      const accepts = typeof readOptions.accept === 'function' ? readOptions.accept : () => true;
      if (readOptions.force !== true) {
        const fresh = finished.get(key);
        if (fresh !== undefined && Date.now() - fresh.at < maxAgeMs && accepts(fresh.report)) {
          return fresh.report;
        }
        const joined = running.get(key);
        if (joined !== undefined) return joined;
      }
      const task = produce().then((report) => {
        remember(key, report);
        return report;
      });
      running.set(key, task);
      try {
        return await task;
      } finally {
        running.delete(key);
      }
    },

    /** @returns {number} Number of reusable reports. */
    size() {
      return finished.size;
    },

    /** Drop everything; used by tests and by a configuration change. */
    clear() {
      finished.clear();
      running.clear();
    },
  };
}
