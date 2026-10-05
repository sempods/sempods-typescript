import type { StoredSession, SessionStore } from './types.js';
export type {
  StoredSession,
  SessionCommit,
  SessionListing,
  SessionStore,
} from './types.js';
export class SessionStorageError extends Error {
  constructor(
    readonly problem:
      'unavailable' | 'closed' | 'unsupported' | 'corrupt' | 'configuration',
  ) {
    super(`Session storage: ${problem}`);
    this.name = 'SessionStorageError';
  }
}

const databaseName = 'sempods:app-sdk:sessions';
const records = 'connections';
type Envelope = StoredSession & {
  readonly schema: 1;
  readonly namespace: string;
};

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function decode(value: unknown, namespace: string, id?: string): StoredSession {
  if (typeof value !== 'object' || value === null)
    throw new SessionStorageError('corrupt');
  const row = value as Record<string, unknown>;
  if (
    typeof row.schema === 'number' &&
    Number.isInteger(row.schema) &&
    row.schema > 1
  ) {
    throw new SessionStorageError('unsupported');
  }
  if (
    row.schema !== 1 ||
    row.namespace !== namespace ||
    !nonempty(row.id) ||
    (id !== undefined && row.id !== id) ||
    !nonempty(row.revision) ||
    !Object.hasOwn(row, 'value')
  )
    throw new SessionStorageError('corrupt');
  return { id: row.id, revision: row.revision, value: row.value };
}

/** No fallback to memory: callers must know when durable storage is unavailable. */
export function openSessionStore(
  namespace: string,
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<SessionStore> {
  return new Promise((resolve, reject) => {
    if (!nonempty(namespace)) {
      reject(new SessionStorageError('configuration'));
      return;
    }
    if (!factory) {
      reject(new SessionStorageError('unavailable'));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(databaseName, 1);
    } catch {
      reject(new SessionStorageError('unavailable'));
      return;
    }
    request.onerror = () =>
      reject(
        new SessionStorageError(
          request.error?.name === 'VersionError'
            ? 'unsupported'
            : 'unavailable',
        ),
      );
    request.onupgradeneeded = () => {
      try {
        const store = request.result.createObjectStore(records, {
          keyPath: ['namespace', 'id'],
        });
        store.createIndex('namespace', 'namespace');
      } catch {
        request.transaction?.abort();
        reject(new SessionStorageError('unavailable'));
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      resolve(sessionStore(database, namespace));
    };
  });
}

type Transaction<T> = {
  readonly store: IDBObjectStore;
  accept(value: T): void;
  read(request: IDBRequest, consume: (value: unknown) => void): void;
};

function sessionStore(database: IDBDatabase, namespace: string): SessionStore {
  let closed = false;
  function close() {
    closed = true;
    database.close();
  }
  database.onversionchange = close;
  database.onclose = () => {
    closed = true;
  };
  // Work is synchronous except IDB requests. A Promise/network callback is never part of this API.
  function transact<T>(
    mode: IDBTransactionMode,
    work: (transaction: Transaction<T>) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (closed) {
        reject(new SessionStorageError('closed'));
        return;
      }
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(
          records,
          mode,
          mode === 'readwrite' ? { durability: 'strict' } : undefined,
        );
      } catch {
        reject(new SessionStorageError('unavailable'));
        return;
      }
      let accepted = false;
      let result: T;
      let failure: SessionStorageError | undefined;
      const abort = (error: unknown) => {
        failure =
          error instanceof SessionStorageError
            ? error
            : new SessionStorageError('unavailable');
        try {
          transaction.abort();
        } catch {
          reject(failure);
        }
      };
      transaction.onabort = () =>
        reject(failure ?? new SessionStorageError('unavailable'));
      transaction.oncomplete = () => {
        if (!accepted) reject(new SessionStorageError('unavailable'));
        else resolve(result);
      };
      try {
        work({
          store: transaction.objectStore(records),
          accept(value) {
            result = value;
            accepted = true;
          },
          read(request, consume) {
            request.onsuccess = () => {
              try {
                consume(request.result as unknown);
              } catch (error) {
                abort(error);
              }
            };
            // Request errors abort the transaction by default; only onabort settles failure.
          },
        });
      } catch (error) {
        abort(error);
      }
    });
  }

  return {
    read(id) {
      if (!nonempty(id))
        return Promise.reject(new SessionStorageError('configuration'));
      return transact('readonly', ({ store, read, accept }) => {
        read(store.get([namespace, id]), (value) =>
          accept(
            value === undefined ? undefined : decode(value, namespace, id),
          ),
        );
      });
    },
    list() {
      return transact('readonly', ({ store, read, accept }) => {
        read(store.index('namespace').getAll(namespace), (value) => {
          if (!Array.isArray(value)) throw new SessionStorageError('corrupt');
          const records: StoredSession[] = [];
          const unreadable: {
            id: string | null;
            problem: 'corrupt' | 'unsupported';
          }[] = [];
          for (const row of value as unknown[]) {
            try {
              records.push(decode(row, namespace));
            } catch (error) {
              if (
                !(error instanceof SessionStorageError) ||
                (error.problem !== 'corrupt' && error.problem !== 'unsupported')
              )
                throw error;
              const id =
                typeof row === 'object' &&
                row !== null &&
                'id' in row &&
                nonempty(row.id)
                  ? row.id
                  : null;
              unreadable.push({ id, problem: error.problem });
            }
          }
          accept({ records, unreadable });
        });
      });
    },
    commit(id, expectedRevision, value) {
      if (
        !nonempty(id) ||
        (expectedRevision !== null && !nonempty(expectedRevision))
      ) {
        return Promise.reject(new SessionStorageError('configuration'));
      }
      // Snapshot before the first await/request: later caller mutation cannot alter this commit.
      let snapshot: unknown;
      try {
        snapshot = structuredClone(value);
      } catch {
        return Promise.reject(new SessionStorageError('configuration'));
      }
      return transact('readwrite', ({ store, read, accept }) => {
        read(store.get([namespace, id]), (raw) => {
          const current =
            raw === undefined ? undefined : decode(raw, namespace, id);
          if ((current?.revision ?? null) !== expectedRevision) {
            accept({ kind: 'conflict' });
            return;
          }
          const record: Envelope = {
            schema: 1,
            namespace,
            id,
            revision: crypto.randomUUID(),
            value: snapshot,
          };
          store.put(record);
          // A successful put is insufficient: transact waits for the whole transaction to commit.
          accept({
            kind: 'committed',
            record: { id, revision: record.revision, value: snapshot },
          });
        });
      });
    },
    close,
  };
}
