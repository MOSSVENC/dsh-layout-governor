/**
 * The self-triggering part: decide when the tree may have changed.
 *
 * The governor is not supposed to need a human to remember to call it. Every tool
 * call the agent finishes is an opportunity: a `write`, a `bash`, an `edit` may
 * have just created the mess the next audit should find. This module turns that
 * stream into one debounced refresh, so a burst of twenty writes costs one scan
 * instead of twenty.
 *
 * It is deliberately dumb. It does not inspect arguments, does not try to guess
 * which shell command touched which directory, and does not read the tree: a tool
 * that can write counts as a change, and the next scan decides what actually
 * happened.
 */

/** Tools whose completion may have changed the tree. */
const MUTATING_TOOLS = new Set([
  'write',
  'edit',
  'apply_patch',
  'bash',
  'pwsh',
  'terminal',
  'str_replace_editor',
  'notebook_edit',
  'worktree_create',
  'subagent',
  'subagent_codex',
  'workflow',
  'layout_governor_apply',
]);

/**
 * Whether a finished tool call could have changed the audited tree.
 *
 * Unknown tools are treated as harmless: a false negative costs one stale report,
 * a false positive on a hot loop would re-walk the tree for nothing.
 *
 * @param {unknown} name Tool name.
 * @returns {boolean}
 */
export function isMutatingTool(name) {
  if (typeof name !== 'string' || name === '') return false;
  if (MUTATING_TOOLS.has(name)) return true;
  // Scoped variants such as `bash:workspace` keep working.
  const base = name.split(':')[0];
  return MUTATING_TOOLS.has(base);
}

/**
 * Create a debounced change watcher.
 *
 * @param {object} options
 * @param {(info: { reason: string, at: number }) => void} options.onChange Called once per quiet period.
 * @param {number} [options.debounceMs] Quiet period before a refresh.
 * @param {() => number} [options.now] Clock, injected for tests.
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimer]
 * @param {(handle: unknown) => void} [options.clearTimer]
 * @returns {{ notify: (toolName: unknown) => boolean, pending: () => boolean, dispose: () => void }}
 */
export function createChangeWatcher(options) {
  const debounceMs =
    Number.isFinite(options.debounceMs) && options.debounceMs >= 0 ? options.debounceMs : 3000;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;

  let handle = null;
  let disposed = false;

  const fire = () => {
    handle = null;
    if (disposed) return;
    options.onChange({ reason: 'workspace-changed', at: now() });
  };

  return {
    /**
     * Report one finished tool call.
     * @param {unknown} toolName Tool name.
     * @returns {boolean} Whether this call armed the watcher.
     */
    notify(toolName) {
      if (disposed || !isMutatingTool(toolName)) return false;
      if (handle !== null) clearTimer(handle);
      handle = setTimer(fire, debounceMs);
      return true;
    },

    /** @returns {boolean} Whether a refresh is armed. */
    pending() {
      return handle !== null;
    },

    /** Cancel any armed refresh; safe to call twice. */
    dispose() {
      disposed = true;
      if (handle !== null) {
        clearTimer(handle);
        handle = null;
      }
    },
  };
}
