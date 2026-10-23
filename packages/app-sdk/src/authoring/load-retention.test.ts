/** Same-authority reload retention (#104): loader states with `retain`. */
import { expect, it, vi } from 'vitest';
import { createViewLoader, type LoadState } from './load.js';
import type { BoundPod, BoundView } from '../runtime/view.js';
import { deferred } from '../runtime/fixture.test.js';

/** A handle with controllable access facts; the loader reads nothing else. */
function handle(kind: 'context' | 'pod') {
  let access = { current: true, read: true, write: true, revision: 1 };
  const listeners = new Set<() => void>();
  const target = {
    ...(kind === 'context' ? { contextIri: 'urn:context' } : {}),
    getSnapshot: () => access,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    view: target as unknown as BoundView & BoundPod,
    change(next: Partial<typeof access>) {
      access = { ...access, ...next };
      listeners.forEach((listener) => listener());
    },
  };
}
type Answer = { kind: 'ok'; body: string } | { kind: 'refused'; status: 403 };
function reads() {
  const answers: ReturnType<typeof deferred<Answer>>[] = [];
  const read = vi.fn(() => {
    const answer = deferred<Answer>();
    answers.push(answer);
    return answer.promise;
  });
  return { read, answers };
}
function states<T>(loader: {
  getSnapshot(): LoadState<T>;
  subscribe(l: () => void): () => void;
}) {
  const seen: LoadState<T>[] = [];
  loader.subscribe(() => seen.push(loader.getSnapshot()));
  return seen;
}

it.each(['context', 'pod'] as const)(
  'keeps the last data while a %s target reloads and after a failed refresh',
  async (kind) => {
    const { view } = handle(kind);
    const { read, answers } = reads();
    const loader = createViewLoader(view, read, { retain: true });
    const first = loader.reload();
    answers[0]!.resolve({ kind: 'ok', body: 'rows' });
    await first;
    const seen = states(loader);
    const second = loader.reload();
    expect(loader.getSnapshot()).toEqual({
      kind: 'loading',
      previous: 'rows',
    });
    answers[1]!.resolve({ kind: 'refused', status: 403 });
    await second;
    expect(loader.getSnapshot()).toEqual({
      kind: 'failed',
      error: { kind: 'refused', status: 403 },
      previous: 'rows',
    });
    // The retry keeps it, and a success replaces it.
    const third = loader.reload();
    expect(loader.getSnapshot()).toMatchObject({ previous: 'rows' });
    answers[2]!.resolve({ kind: 'ok', body: 'fresh' });
    await third;
    expect(loader.getSnapshot()).toEqual({ kind: 'ready', data: 'fresh' });
    // No empty frame on the way.
    expect(seen.every((s) => s.kind === 'ready' || 'previous' in s)).toBe(true);
    loader.dispose();
  },
);

it('shows no previous data without retain or before a first result', async () => {
  const { view } = handle('context');
  const { read, answers } = reads();
  const loader = createViewLoader(view, read);
  const first = loader.reload();
  answers[0]!.resolve({ kind: 'ok', body: 'rows' });
  await first;
  void loader.reload();
  expect(loader.getSnapshot()).toEqual({ kind: 'loading' });
  loader.dispose();
  const retained = createViewLoader(view, reads().read, { retain: true });
  void retained.reload();
  expect(retained.getSnapshot()).toEqual({ kind: 'loading' });
  retained.dispose();
});

it('ignores a late answer of a superseded reload', async () => {
  const { view } = handle('context');
  const { read, answers } = reads();
  const loader = createViewLoader(view, read, { retain: true });
  const first = loader.reload();
  answers[0]!.resolve({ kind: 'ok', body: 'rows' });
  await first;
  const stale = loader.reload();
  const latest = loader.reload();
  answers[2]!.resolve({ kind: 'ok', body: 'latest' });
  await latest;
  answers[1]!.resolve({ kind: 'ok', body: 'late' });
  await stale;
  expect(loader.getSnapshot()).toEqual({ kind: 'ready', data: 'latest' });
  loader.dispose();
});

it.each(['access loss', 'cancel', 'fresh reload', 'grants change'] as const)(
  'drops retained data after %s',
  async (cause) => {
    const { view, change } = handle(
      cause === 'grants change' ? 'pod' : 'context',
    );
    const { read, answers } = reads();
    const loader = createViewLoader(view, read, { retain: true });
    const first = loader.reload();
    answers[0]!.resolve({ kind: 'ok', body: 'rows' });
    await first;
    if (cause === 'access loss') {
      change({ read: false });
      expect(loader.getSnapshot()).toEqual({ kind: 'unavailable' });
      change({ read: true });
    } else if (cause === 'cancel') loader.cancel();
    else if (cause === 'grants change') {
      // A Pod result belongs to its grants: the change rereads without it.
      change({ revision: 2 });
      expect(loader.getSnapshot()).toEqual({ kind: 'loading' });
    }
    if (cause !== 'grants change')
      void loader.reload(cause === 'fresh reload' ? { fresh: true } : {});
    expect(loader.getSnapshot()).toEqual({ kind: 'loading' });
    loader.dispose();
  },
);

it('keeps a Context loader’s data across a write-only access change', async () => {
  const { view, change } = handle('context');
  const { read, answers } = reads();
  const loader = createViewLoader(view, read, { retain: true });
  const first = loader.reload();
  answers[0]!.resolve({ kind: 'ok', body: 'rows' });
  await first;
  change({ write: false, revision: 2 });
  expect(loader.getSnapshot()).toEqual({ kind: 'ready', data: 'rows' });
  void loader.reload();
  expect(loader.getSnapshot()).toEqual({ kind: 'loading', previous: 'rows' });
  loader.dispose();
});

it('reads retain at each reload', async () => {
  const { view } = handle('context');
  const { read, answers } = reads();
  const options = { retain: false };
  const loader = createViewLoader(view, read, options);
  const first = loader.reload();
  answers[0]!.resolve({ kind: 'ok', body: 'rows' });
  await first;
  options.retain = true;
  void loader.reload();
  expect(loader.getSnapshot()).toEqual({ kind: 'loading', previous: 'rows' });
  loader.dispose();
});
