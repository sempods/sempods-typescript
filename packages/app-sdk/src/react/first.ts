import { useEffect, useState, useSyncExternalStore } from 'react';
import { useController } from './app.js';

type Kind = 'gate' | 'prompts';
interface Owners {
  readonly mounted: Record<Kind, symbol[]>;
  readonly listeners: Set<() => void>;
}
const registry = new WeakMap<object, Owners>();
function ownersOf(app: object) {
  let owners = registry.get(app);
  if (!owners) {
    owners = { mounted: { gate: [], prompts: [] }, listeners: new Set() };
    registry.set(app, owners);
  }
  return owners;
}

/**
 * Internal: whether this instance is the first mounted of its kind under the
 * provider. An app may render `AppAccess` more than once (for example inline
 * and inside its own dialog); only one gate and one prompt stack show.
 */
export function useFirst(kind: Kind): boolean {
  const app = useController();
  const [token] = useState(() => Symbol(kind));
  const owners = ownersOf(app);
  useEffect(() => {
    owners.mounted[kind].push(token);
    owners.listeners.forEach((listener) => listener());
    return () => {
      const list = owners.mounted[kind];
      list.splice(list.indexOf(token), 1);
      owners.listeners.forEach((listener) => listener());
    };
  }, [owners, kind, token]);
  const first = () => owners.mounted[kind][0] === token;
  return useSyncExternalStore(
    (listener) => {
      owners.listeners.add(listener);
      return () => owners.listeners.delete(listener);
    },
    first,
    first,
  );
}
