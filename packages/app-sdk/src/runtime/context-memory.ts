import type { PreferenceStorage } from './types.js';

/**
 * Remembers the person's last explicit context choice per connection, so a
 * reload can offer the same target again. With a tab storage, a tab's own
 * choice comes first, so a reload keeps it beside another tab's choice; the
 * shared one serves a new tab and the next start. A convenience, never an access grant:
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
  /** This tab's storage (`sessionStorage`), read lazily; none by default. */
  tab: () => PreferenceStorage | null | undefined = () => undefined,
): ContextMemory {
  const key = prefix + namespace;
  const activeKey = activePrefix + namespace;
  /** This tab's storage first, then the device's. */
  const stores = (): PreferenceStorage[] => {
    let own: PreferenceStorage | null | undefined;
    try {
      own = tab();
    } catch {
      own = undefined;
    }
    return [own, storage].filter((s): s is PreferenceStorage => !!s);
  };
  // Like a Context choice: this tab's own first, the device's for a new tab.
  const active: ActiveMemory = {
    recall() {
      for (const from of stores())
        try {
          const id = from.getItem(activeKey);
          if (id !== null) return id;
        } catch {
          // Not remembered there.
        }
      return undefined;
    },
    remember(id) {
      for (const to of stores())
        try {
          if (to.getItem(activeKey) !== id) to.setItem(activeKey, id);
        } catch {
          // The connection simply is not remembered there.
        }
    },
  };
  const read = (from: PreferenceStorage): Record<string, string> => {
    try {
      const value: unknown = JSON.parse(from.getItem(key) ?? '{}');
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
  const write = (to: PreferenceStorage, choices: Record<string, string>) => {
    try {
      if (Object.keys(choices).length === 0) to.removeItem(key);
      else to.setItem(key, JSON.stringify(choices));
    } catch {
      // The choice simply is not remembered.
    }
  };
  return {
    recall(id) {
      for (const from of stores()) {
        const iri = read(from)[id];
        if (iri !== undefined) return iri;
      }
      return undefined;
    },
    remember(id, iri) {
      for (const to of stores()) {
        const choices = read(to);
        if (choices[id] !== iri) write(to, { ...choices, [id]: iri });
      }
    },
    active,
    forget(id) {
      for (const from of stores())
        try {
          if (from.getItem(activeKey) === id) from.removeItem(activeKey);
        } catch {
          // Left behind, it names a connection that no longer exists.
        }
      for (const from of stores()) {
        const choices = read(from);
        if (!(id in choices)) continue;
        delete choices[id];
        write(from, choices);
      }
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
