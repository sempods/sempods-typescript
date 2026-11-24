import { RuntimeError } from '../runtime/errors.js';
import { openSessionStore, type SessionStore } from './store.js';

import type { SessionLocks } from './types.js';
export type { SessionLocks } from './types.js';
export interface SessionLease {
  readonly store: SessionStore;
  /**
   * Closes the store and releases the lease once `after` has settled. Until
   * the lease is released, a new lease of this page on the same locks and
   * namespace waits for it instead of finding it held (#419).
   */
  close(after?: Promise<unknown>): void;
}

/** Leases of this page that are closing, until each is released (#419). */
const closing = new WeakMap<SessionLocks, Map<string, Set<Promise<void>>>>();
/**
 * Waits until every lease of this page that is closing has been released, or
 * until `signal` aborts.
 */
async function closed(
  locks: SessionLocks,
  namespace: string,
  signal: AbortSignal | undefined,
) {
  const pending = closing.get(locks)?.get(namespace);
  if (!pending?.size) return;
  let stop!: () => void;
  const aborted = new Promise<void>((resolve) => (stop = resolve));
  signal?.addEventListener('abort', stop, { once: true });
  try {
    while (pending.size && !signal?.aborted)
      await Promise.race([Promise.all(pending), aborted]);
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}

/**
 * Opens the app's session store and takes its lease, never waiting for a
 * holder. A store that announces its changes (`watch`) shares the lease with
 * the app's other tabs; one without needs it alone, so a second tab is
 * `busy`. The two exclude each other, also across SDK versions that only knew
 * the exclusive lease. A lease of this page that is closing holds nothing any
 * more: the new one opens once it has been released, so a replacement runtime
 * starts after a disposed one's cleanup (#419).
 */
export async function acquireSessionLease(
  namespace: string,
  locks: SessionLocks | null | undefined,
  openStore: () => Promise<SessionStore> = () => openSessionStore(namespace),
  signal?: AbortSignal,
): Promise<SessionLease> {
  if (!locks) throw new RuntimeError('coordination');
  await closed(locks, namespace, signal);
  // A runtime disposed meanwhile takes no lease, so a replacement that
  // stopped waiting with it finds the lock free (#419).
  if (signal?.aborted) throw new RuntimeError('disconnected');
  let store: SessionStore;
  try {
    store = await openStore();
  } catch {
    throw new RuntimeError('storage');
  }
  if (signal?.aborted) {
    store.close();
    throw new RuntimeError('disconnected');
  }
  const mode = store.watch ? 'shared' : 'exclusive';
  return new Promise((resolve, reject) => {
    const fail = (error: RuntimeError) => {
      store.close();
      reject(error);
    };
    try {
      // Settles once the lock is released (or was never granted).
      const released: Promise<void> = locks
        .request(
          `sempods:sessions:${namespace}`,
          { ifAvailable: true, mode },
          async (lock) => {
            if (!lock) {
              fail(new RuntimeError('busy'));
              return;
            }
            await new Promise<void>((release) => {
              let ended = false;
              resolve({
                store,
                close(after = Promise.resolve()) {
                  if (ended) return;
                  ended = true;
                  const byPage =
                    closing.get(locks) ?? new Map<string, Set<Promise<void>>>();
                  closing.set(locks, byPage);
                  const pending = byPage.get(namespace) ?? new Set();
                  byPage.set(namespace, pending);
                  const done: Promise<void> = Promise.allSettled([after])
                    .then(() => {
                      try {
                        store.close();
                      } finally {
                        release();
                      }
                      return released;
                    })
                    .catch(() => undefined)
                    .finally(() => {
                      pending.delete(done);
                      if (!pending.size) byPage.delete(namespace);
                    });
                  pending.add(done);
                },
              });
            });
          },
        )
        .catch(() => fail(new RuntimeError('coordination')));
    } catch {
      fail(new RuntimeError('coordination'));
    }
  });
}
