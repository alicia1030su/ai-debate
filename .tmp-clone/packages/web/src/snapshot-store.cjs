'use strict'
/**
 * Minimal replacement for the host's snapshot store.
 *
 * The page only needs three operations: read the current snapshot, subscribe to
 * changes, and replace the snapshot. Notification is argument-less on purpose —
 * the page passes `setState` straight in, and React reads a call with an
 * argument as "set state to that value". A listener called with `undefined`
 * would blank the card on the first publish.
 *
 * Deliberately no Immer and no deep freeze/clone: every snapshot the page builds
 * is a plain object of primitives, arrays and plain objects (the draft `Map` is
 * flattened to a count plus a field map before it crosses this boundary). Adding
 * structural sharing here would buy nothing and would reintroduce the exact
 * class of failure — a `Map` the store refuses — that this shim replaces.
 */

/**
 * Create a snapshot store.
 *
 * @param {unknown} initial The first snapshot.
 * @returns {{getSnapshot: () => unknown, subscribe: (listener: () => void) => () => boolean, set: (next: unknown) => void}}
 *   The three methods the page calls, and nothing else.
 */
function createSnapshotStore(initial) {
  let snapshot = initial
  const listeners = new Set()

  return {
    /** @returns {unknown} The current snapshot. */
    getSnapshot: () => snapshot,

    /**
     * Register a change listener.
     *
     * @param {() => void} listener Called with no arguments after every `set`.
     * @returns {() => boolean} Unsubscribe function.
     */
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /**
     * Replace the snapshot and notify every current listener.
     *
     * Iterates a copy so a listener that unsubscribes during notification does
     * not change the set of listeners this pass still has to reach.
     *
     * @param {unknown} next The new snapshot.
     * @returns {void}
     */
    set(next) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

module.exports = { createSnapshotStore }
