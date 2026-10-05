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
  forget(id: string): void;
}

const prefix = '@sempods/app-sdk:context:';

export function createContextMemory(
  namespace: string,
  storage: PreferenceStorage | null | undefined,
): ContextMemory {
  const key = prefix + namespace;
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
    forget(id) {
      if (!storage) return;
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
