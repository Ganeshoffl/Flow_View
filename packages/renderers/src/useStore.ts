/**
 * React binding for the TraceStore.
 *
 * The store is framework-free and mutates state in place, so React cannot detect a change by
 * comparing objects. It subscribes to the store's notifications and uses the `version` counter as
 * the snapshot: a number, cheap to compare, that changes exactly when state does.
 *
 * `useSyncExternalStore` is what makes this safe under concurrent rendering — it guarantees a render
 * observes one consistent version rather than a heap half-mutated by a step in progress.
 *
 * There is deliberately no selector hook. A selector returning a derived object would hand
 * `useSyncExternalStore` a fresh identity on every read, which it treats as a change, which
 * schedules another render: an infinite loop. Components subscribe to the version and read whatever
 * they need from live state during render instead. Simpler, and it cannot spin.
 */

import { useCallback, useSyncExternalStore } from "react";

import type { TraceStore } from "@flow-view/trace-store";

/** Re-render whenever the store changes. */
export function useTraceVersion(store: TraceStore): number {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const snapshot = useCallback(() => store.state.version, [store]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
