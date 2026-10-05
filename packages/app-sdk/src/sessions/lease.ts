import { RuntimeError } from '../runtime/errors.js';
import { openSessionStore, type SessionStore } from './store.js';

import type { SessionLocks } from './types.js';
export type { SessionLocks } from './types.js';
export interface SessionLease {
  readonly store: SessionStore;
  close(): void;
}

/** One active durable coordinator per configuration until concurrent-tab propagation is implemented. */
export function acquireSessionLease(
  namespace: string,
  locks: SessionLocks | null | undefined,
  openStore: () => Promise<SessionStore> = () => openSessionStore(namespace),
): Promise<SessionLease> {
  if (!locks) return Promise.reject(new RuntimeError('coordination'));
  return new Promise((resolve, reject) => {
    try {
      void locks
        .request(
          `sempods:sessions:${namespace}`,
          { ifAvailable: true },
          async (lock) => {
            if (!lock) {
              reject(new RuntimeError('busy'));
              return;
            }
            let store: SessionStore;
            try {
              store = await openStore();
            } catch {
              reject(new RuntimeError('storage'));
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
        .catch(() => reject(new RuntimeError('coordination')));
    } catch {
      reject(new RuntimeError('coordination'));
    }
  });
}
