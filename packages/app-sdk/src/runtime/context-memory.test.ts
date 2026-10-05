/**
 * The last explicitly chosen context survives a reload as a convenience: it is
 * reselected only while the fresh catalogue lists it as readable, never
 * replaced by another context, forgotten on disconnect, and storage failures
 * only disable the convenience.
 */
import { afterEach, expect, it } from 'vitest';
import type { BrowserRuntime, PreferenceStorage } from './types.js';
import { createBrowserRuntime } from './runtime.js';
import { createContextMemory } from './context-memory.js';
import {
  fixture,
  settleLease,
  restored,
  catalogue,
  work,
  personal,
} from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach((r) => r.dispose());
});
function memoryStorage(): PreferenceStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}
async function loggedIn(preferences: PreferenceStorage | null) {
  const f = fixture({ preferences });
  runtimes.push(f.runtime);
  const result = await f.login();
  runtimes.push(result.runtime);
  return { ...f, ...result };
}
async function reload(
  f: Awaited<ReturnType<typeof loggedIn>>,
  current: BrowserRuntime,
) {
  current.dispose();
  await settleLease();
  const next = createBrowserRuntime({
    ...f.options,
    location: () => 'https://app.example/',
  });
  runtimes.push(next);
  await next.initialize();
  await restored(next);
  return next;
}
const selected = (runtime: BrowserRuntime, id: string) =>
  runtime.getSnapshot().find((c) => c.id === id)?.selectedContext;

it('reselects the last chosen context after a reload once the catalogue confirms it', async () => {
  const storage = memoryStorage();
  const f = await loggedIn(storage);
  f.runtime.selectContext(f.id, personal);
  const next = await reload(f, f.runtime);
  expect(selected(next, f.id)).toBeNull();
  await next.loadContexts(f.id);
  expect(selected(next, f.id)).toBe(personal);
  expect(next.bind(f.id).contextIri).toBe(personal);
});

it('keeps the selection empty when the remembered context is no longer readable', async () => {
  const storage = memoryStorage();
  const f = await loggedIn(storage);
  f.setCatalogue(async () => catalogue([personal], []));
  const next = await reload(f, f.runtime);
  await next.loadContexts(f.id);
  expect(selected(next, f.id)).toBeNull();
  // Access returns: the remembered choice applies again, nothing else did.
  f.setCatalogue(async () => catalogue());
  await next.loadContexts(f.id);
  expect(selected(next, f.id)).toBe(work);
});

it('never overrides a choice made in this session', async () => {
  const storage = memoryStorage();
  const f = await loggedIn(storage);
  const next = await reload(f, f.runtime);
  // The catalogue is not loaded yet; the person cannot choose before it is.
  await next.loadContexts(f.id);
  next.selectContext(f.id, personal);
  await next.loadContexts(f.id);
  expect(selected(next, f.id)).toBe(personal);
});

it('forgets the choice when the connection is disconnected', async () => {
  const storage = memoryStorage();
  const f = await loggedIn(storage);
  expect(storage.map.size).toBe(1);
  expect(await f.runtime.disconnect(f.id)).toEqual({ kind: 'disconnected' });
  expect(storage.map.size).toBe(0);
});

it('null preferences disable remembering', async () => {
  const f = await loggedIn(null);
  const next = await reload(f, f.runtime);
  await next.loadContexts(f.id);
  expect(selected(next, f.id)).toBeNull();
});

it('storage failures and foreign values only disable the convenience', () => {
  const failing: PreferenceStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('quota');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  const memory = createContextMemory('ns', failing);
  expect(() => memory.remember('a', work)).not.toThrow();
  expect(memory.recall('a')).toBeUndefined();
  expect(() => memory.forget('a')).not.toThrow();

  const storage = memoryStorage();
  const other = createContextMemory('ns', storage);
  for (const raw of ['not json', '[]', '"text"', '{"a":5}']) {
    storage.map.set('@sempods/app-sdk:context:ns', raw);
    expect(other.recall('a')).toBeUndefined();
  }
  other.remember('a', work);
  other.remember('b', personal);
  other.forget('a');
  expect(other.recall('a')).toBeUndefined();
  expect(other.recall('b')).toBe(personal);
  // Namespaces stay separate.
  expect(createContextMemory('other', storage).recall('b')).toBeUndefined();
});
