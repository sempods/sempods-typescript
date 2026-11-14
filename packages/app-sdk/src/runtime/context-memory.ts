import type { PreferenceStorage } from './types.js';

/**
 * Remembers the person's last explicit context choice per connection, so a
 * reload can offer the same target again. A convenience, never an access grant:
 * the runtime reselects it only when the fresh catalogue still lists it as
 * readable. Storage failures (private mode, quota, blocked site data) only
 * disable the convenience.
 */
export interface ContextMemory {
  recall(id: string): string | undefined;
  remember(id: string, iri: string): void;
  /** Forgets the connection's Context, and the connection as the last active one. */
  forget(id: string): void;
  /**
   * The connection the app last worked with (#305), so the next start prefers
   * it. A convenience like the Context, never a grant.
   */
  readonly active: ActiveMemory;
}
/** The last active connection of one app identity. */
export interface ActiveMemory {
  recall(): string | undefined;
  remember(id: string): void;
}

const prefix = '@sempods/app-sdk:context:';
const activePrefix = '@sempods/app-sdk:active:';

export function createContextMemory(
  namespace: string,
  storage: PreferenceStorage | null | undefined,
): ContextMemory {
  const key = prefix + namespace;
  const activeKey = activePrefix + namespace;
  const active: ActiveMemory = {
    recall() {
      try {
        return storage?.getItem(activeKey) ?? undefined;
      } catch {
        return undefined;
      }
    },
    remember(id) {
      try {
        if (storage && storage.getItem(activeKey) !== id)
          storage.setItem(activeKey, id);
      } catch {
        // The connection simply is not remembered.
      }
    },
  };
  const read = (): Record<string, string> => {
    try {
      const value: unknown = JSON.parse(storage?.getItem(key) ?? '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return {};
      return Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
    } catch {
      return {};
    }
  };
  const write = (choices: Record<string, string>) => {
    try {
      if (Object.keys(choices).length === 0) storage?.removeItem(key);
      else storage?.setItem(key, JSON.stringify(choices));
    } catch {
      // The choice simply is not remembered.
    }
  };
  return {
    recall: (id) => read()[id],
    remember(id, iri) {
      if (!storage || read()[id] === iri) return;
      write({ ...read(), [id]: iri });
    },
    active,
    forget(id) {
      if (!storage) return;
      if (active.recall() === id)
        try {
          storage.removeItem(activeKey);
        } catch {
          // Left behind, it names a connection that no longer exists.
        }
      const choices = read();
      if (!(id in choices)) return;
      delete choices[id];
      write(choices);
    },
  };
}

/** The browser's localStorage when present and accessible. */
export function browserPreferences(): PreferenceStorage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Internal: the runtime's memory of its last active connection, for the
 * controller's startup choice (#305). Absent for a runtime not created by
 * `createBrowserRuntime`, which keeps the store order.
 */
export const activeMemories = new WeakMap<object, ActiveMemory>();
