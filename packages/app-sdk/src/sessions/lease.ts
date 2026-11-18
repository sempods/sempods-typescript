import { RuntimeError } from '../runtime/errors.js';
import { openSessionStore, type SessionStore } from './store.js';

import type { SessionLocks } from './types.js';
export type { SessionLocks } from './types.js';
export interface SessionLease {
  readonly store: SessionStore;
  close(): void;
}

/**
 * Opens the app's session store and takes its lease, never waiting for it.
 * A store that announces its changes (`watch`) shares the lease with the
 * app's other tabs; one without needs it alone, so a second tab is `busy`.
 * The two exclude each other, also across SDK versions that only knew the
 * exclusive lease.
 */
export async function acquireSessionLease(
  namespace: string,
  locks: SessionLocks | null | undefined,
  openStore: () => Promise<SessionStore> = () => openSessionStore(namespace),
): Promise<SessionLease> {
  if (!locks) throw new RuntimeError('coordination');
  let store: SessionStore;
  try {
    store = await openStore();
  } catch {
    throw new RuntimeError('storage');
  }
  const mode = store.watch ? 'shared' : 'exclusive';
  return new Promise((resolve, reject) => {
    const fail = (error: RuntimeError) => {
      store.close();
      reject(error);
    };
    try {
      void locks
        .request(
          `sempods:sessions:${namespace}`,
          { ifAvailable: true, mode },
          async (lock) => {
            if (!lock) {
              fail(new RuntimeError('busy'));
              return;
            }
            await new Promise<void>((release) =>
              resolve({
                store,
                close() {
                  store.close();
                  release();
                },
              }),
            );
          },
        )
        .catch(() => fail(new RuntimeError('coordination')));
    } catch {
      fail(new RuntimeError('coordination'));
    }
  });
}
