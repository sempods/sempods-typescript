import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserRuntime } from '../runtime/types.js';
import type { BoundView } from '../runtime/view.js';
import { fixture, personal, work } from '../runtime/fixture.test.js';
import {
  changed,
  observeStarts,
  observeWrites,
  startCount,
  started,
} from './changes.js';

const runtimes: BrowserRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach((r) => r.dispose());
  vi.restoreAllMocks();
});
async function signedIn() {
  const f = fixture();
  const session = await f.login();
  runtimes.push(f.runtime, session.runtime);
  return { ...f, ...session };
}

it('shares write events and start counts between the selected and an explicit handle of one Context', async () => {
  const f = await signedIn();
  const selected = f.runtime.bind(f.id);
  const explicit = f.runtime.bindContext(f.id, work);
  const onSelected = vi.fn();
  const onExplicit = vi.fn();
  observeWrites(selected, onSelected);
  observeWrites(explicit, onExplicit);
  changed(explicit);
  expect(onSelected).toHaveBeenCalledOnce();
  changed(selected);
  expect(onExplicit).toHaveBeenCalledTimes(2);
  const starts = vi.fn();
  observeStarts(selected, starts);
  const before = startCount(selected);
  expect(started(explicit)).toBe(before + 1);
  expect(startCount(selected)).toBe(before + 1);
  expect(starts).toHaveBeenCalledOnce();
});

it('keeps writes of another Context to themselves', async () => {
  const f = await signedIn();
  const selected = f.runtime.bind(f.id);
  const other = f.runtime.bindContext(f.id, personal);
  const onSelected = vi.fn();
  observeWrites(selected, onSelected);
  changed(other);
  started(other);
  expect(onSelected).not.toHaveBeenCalled();
  expect(startCount(selected)).toBe(0);
});

it('joins a new selected handle after A → B → A with the explicit handle of A', async () => {
  const f = await signedIn();
  const explicit = f.runtime.bindContext(f.id, work);
  const first = f.runtime.bind(f.id);
  f.runtime.selectContext(f.id, personal);
  f.runtime.selectContext(f.id, work);
  const again = f.runtime.bind(f.id);
  expect(again).not.toBe(first);
  const onAgain = vi.fn();
  observeWrites(again, onAgain);
  changed(explicit);
  expect(onAgain).toHaveBeenCalledOnce();
});

it('never joins targets of different connections, even with the same Context IRI', async () => {
  const a = await signedIn();
  const b = await signedIn();
  const viewA = a.runtime.bindContext(a.id, work);
  const viewB = b.runtime.bindContext(b.id, work);
  expect(viewA.contextIri).toBe(viewB.contextIri);
  const onB = vi.fn();
  observeWrites(viewB, onB);
  changed(viewA);
  started(viewA);
  expect(onB).not.toHaveBeenCalled();
  expect(startCount(viewB)).toBe(0);
});

it('keeps a view created outside the runtime as its own target', () => {
  const fake = { contextIri: work } as unknown as BoundView;
  const other = { contextIri: work } as unknown as BoundView;
  const onFake = vi.fn();
  observeWrites(fake, onFake);
  changed(other);
  expect(onFake).not.toHaveBeenCalled();
  changed(fake);
  expect(onFake).toHaveBeenCalledOnce();
});
