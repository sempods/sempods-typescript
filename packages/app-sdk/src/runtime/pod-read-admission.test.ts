// `podReadLimit` (#244): bounded explicit Pod reads across loaders, on the
// real runtime and loader. Fixture evidence only, not live Pod behaviour.
import { afterEach, expect, it, vi } from 'vitest';
import type { PodFetch } from '@sempods/client-sdk';
import { createViewLoader } from '../authoring/load.js';
import { RuntimeError } from './errors.js';
import type { BrowserRuntime, BrowserRuntimeOptions } from './types.js';
import type { BoundPod } from './view.js';
import {
  fixture,
  jwt,
  returnedSession,
  twoPods,
  unauthorized,
  work,
} from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
afterEach(() => runtimes.splice(0).forEach((r) => r.dispose()));
const keep = (runtime: BrowserRuntime) => void runtimes.push(runtime);
const query = (name: string) =>
  `CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o } #${name}`;
const loaders: { dispose(): void }[] = [];
afterEach(() => loaders.splice(0).forEach((l) => l.dispose()));

/**
 * A Pod query transport that ignores aborts: each request stays in flight
 * until it is answered (`answer`, or after a short delay with `auto`).
 * Records every dispatch by read name and the in-flight maxima.
 */
function transport(
  f: { setQuery(fn: PodFetch): void },
  { auto = false, first }: { auto?: boolean; first?: () => Response } = {},
) {
  const pending: { name: string; settle: () => void }[] = [];
  const dispatched: { name: string; pod: string }[] = [];
  const running = new Map<string, number>();
  let total = 0;
  const maxima = { total: 0, perPod: 0 };
  f.setQuery((url, init) => {
    const pod = url.split('/_system')[0]!;
    const name = /#(\S+)$/.exec(String(init?.body))![1]!;
    const index = dispatched.push({ name, pod }) - 1;
    total++;
    running.set(pod, (running.get(pod) ?? 0) + 1);
    maxima.total = Math.max(maxima.total, total);
    maxima.perPod = Math.max(maxima.perPod, running.get(pod)!);
    const response =
      first && index === 0
        ? first()
        : Response.json([{ '@id': `urn:${name}`, 'urn:dispatch': index }]);
    return new Promise<Response>((resolve) => {
      const entry = {
        name,
        settle: () => {
          pending.splice(pending.indexOf(entry), 1);
          total--;
          running.set(pod, running.get(pod)! - 1);
          resolve(response);
        },
      };
      pending.push(entry);
      if (auto) setTimeout(entry.settle, Math.floor(Math.random() * 3));
    });
  });
  return {
    dispatched,
    maxima,
    pending,
    names: () => dispatched.map((d) => d.name),
    /** Answers the oldest request still in flight (or the one named). */
    answer(name?: string) {
      const entry = name ? pending.find((p) => p.name === name) : pending[0];
      entry!.settle();
    },
  };
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

/**
 * A signed-in connection granted the optional `ai` and `mcp` scopes, and its
 * Pod handle. A renewal may only narrow grants, so `grants('ai')` and then
 * `grants('')` are two revisions.
 */
async function session(podReadLimit: BrowserRuntimeOptions['podReadLimit']) {
  const f = await returnedSession(
    keep,
    fixture({
      preferences: null,
      scopes: { optional: ['ai', 'mcp'] },
      ...(podReadLimit ? { podReadLimit } : {}),
    }),
  );
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ scope: 'ai mcp' }),
      token_type: 'Bearer',
      refresh_token: 'initial',
    }),
  );
  await f.runtime.initialize();
  const reader = f.runtime.bindPod(f.id);
  // Context reads need the catalogue; they renew the shared credential.
  await f.runtime.loadContexts(f.id);
  const context = f.runtime.bindContext(f.id, work);
  /**
   * Changes the Pod grants through a Context read's renewal: Context reads
   * are not counted, so this works while every Pod slot is busy.
   */
  async function grants(scope: string) {
    // The catalogue revalidates after each change before Context reads again.
    await flush();
    await vi.waitFor(() => expect(context.getSnapshot().read).toBe(true));
    const before = reader.getSnapshot().revision;
    f.setToken(async () =>
      Response.json({
        access_token: jwt({ scope }),
        token_type: 'Bearer',
        refresh_token: `refresh-${scope || 'none'}`,
      }),
    );
    let calls = 0;
    f.setResource(async () =>
      ++calls === 1
        ? unauthorized()
        : Response.json({ '@id': 'urn:item' }, { headers: { etag: '"v1"' } }),
    );
    await context.subjects.get('urn:item').catch(() => {});
    expect(reader.getSnapshot().revision).toBe(before + 1);
  }
  return { ...f, reader, grants };
}
function loader(reader: BoundPod, name: string) {
  const l = createViewLoader(reader, (pod, signal) =>
    pod.sparql.construct(query(name), { signal }),
  );
  loaders.push(l);
  return l;
}
const id = (l: ReturnType<typeof loader>) => {
  const state = l.getSnapshot();
  return state.kind === 'ready' ? state.data[0]!['@id'] : state.kind;
};

it('rejects an invalid podReadLimit at construction', () => {
  for (const podReadLimit of [{ total: 0 }, { perPod: 2.5 }, { perPod: -1 }])
    expect(() => fixture({ podReadLimit })).toThrow(
      new RuntimeError('configuration'),
    );
});

it('bounds hundreds of delayed reads across two Pods, which take turns', async () => {
  const { f, runtime, other } = await twoPods(keep, {
    podReadLimit: { perPod: 4, total: 6 },
  });
  const t = transport(f, { auto: true });
  const alice = runtime.bindPod(f.id);
  const bob = runtime.bindPod(other.id);
  const all = [
    ...Array.from({ length: 200 }, (_, i) => loader(alice, `alice-${i}`)),
    ...Array.from({ length: 100 }, (_, i) => loader(bob, `bob-${i}`)),
  ];
  all.forEach((l) => void l.reload());
  await vi.waitFor(
    () => expect(all.every((l) => l.getSnapshot().kind === 'ready')).toBe(true),
    { timeout: 10_000 },
  );
  all.forEach((l, i) =>
    expect(id(l)).toBe(i < 200 ? `urn:alice-${i}` : `urn:bob-${i - 200}`),
  );
  // One request per read, never more than the limits allow.
  expect(t.dispatched).toHaveLength(300);
  expect(t.maxima.perPod).toBeLessThanOrEqual(4);
  expect(t.maxima.total).toBe(6);
  // Bob is served alongside Alice, not after her 200 reads.
  const early = t.dispatched.slice(0, 100);
  expect(early.filter((d) => d.name.startsWith('bob')).length).toBeGreaterThan(
    35,
  );
});

it('a reload burst never dispatches superseded waiting reads and keeps cancelled ones counted until they settle', async () => {
  const f = await session({ perPod: 4 });
  const t = transport(f);
  const all = Array.from({ length: 100 }, (_, i) => loader(f.reader, `r${i}`));
  all.forEach((l) => void l.reload());
  await flush();
  expect(t.dispatched).toHaveLength(4);
  // Twice: every read restarts, the four running ones are cancelled but keep
  // their slots (this transport ignores aborts).
  all.forEach((l) => void l.reload());
  all.forEach((l) => void l.reload());
  await flush();
  expect(t.dispatched).toHaveLength(4);
  while (t.pending.length) {
    t.answer();
    await flush();
  }
  // The four cancelled requests plus exactly one current read each.
  expect(t.dispatched).toHaveLength(104);
  expect(t.maxima.perPod).toBe(4);
  for (const [i, l] of all.entries()) {
    const state = l.getSnapshot();
    expect(state.kind).toBe('ready');
    // Each loader shows its latest request's answer, not a cancelled one's.
    const last = t.names().lastIndexOf(`r${i}`);
    if (state.kind === 'ready')
      expect(state.data[0]!['urn:dispatch']).toBe(last);
  }
});

it('a cancelled read returns at once but its slot waits for an abort-ignoring transport', async () => {
  const f = await session({ perPod: 1 });
  const t = transport(f);
  const stop = new AbortController();
  const first = f.reader.sparql.construct(query('first'), {
    signal: stop.signal,
  });
  await flush();
  const second = f.reader.sparql.construct(query('second'));
  stop.abort();
  expect(await first).toEqual({ kind: 'cancelled' });
  await flush();
  expect(t.names()).toEqual(['first']);
  t.answer('first');
  await flush();
  expect(t.names()).toEqual(['first', 'second']);
  t.answer('second');
  expect(await second).toMatchObject({ kind: 'ok' });
});

it('two grant revisions while a loader waits spend no recovery: one request, then ready (late answer dropped)', async () => {
  const f = await session({ perPod: 1 });
  const t = transport(f);
  const blocker = f.reader.sparql.construct(query('blocker'));
  await flush();
  const waiting = loader(f.reader, 'waiting');
  void waiting.reload();
  await flush();
  expect(t.names()).toEqual(['blocker']);
  await f.grants('ai');
  await f.grants('');
  // The blocker's answer belongs to old grants; it still holds the slot.
  expect(await blocker).toEqual({ kind: 'invalidated' });
  expect(waiting.getSnapshot().kind).toBe('loading');
  expect(t.names()).toEqual(['blocker']);
  t.answer('blocker');
  await flush();
  expect(t.names()).toEqual(['blocker', 'waiting']);
  t.answer('waiting');
  await vi.waitFor(() => expect(id(waiting)).toBe('urn:waiting'));
});

it('an admitted read still has one recovery: a second revision while it runs ends unavailable', async () => {
  const f = await session({ perPod: 2 });
  const t = transport(f);
  const l = loader(f.reader, 'admitted');
  void l.reload();
  await flush();
  await f.grants('ai');
  await flush();
  // Recovery: a new request beside the old one, which keeps its slot.
  expect(t.names()).toEqual(['admitted', 'admitted']);
  await f.grants('');
  expect(l.getSnapshot().kind).toBe('unavailable');
  while (t.pending.length) t.answer();
  await flush();
  expect(l.getSnapshot().kind).toBe('unavailable');
  expect(t.dispatched).toHaveLength(2);
});

it('changed grants drop waiting reads of the old grants; new reads wait for old requests to settle and never show old data', async () => {
  const f = await session({ perPod: 2 });
  const t = transport(f);
  const all = Array.from({ length: 5 }, (_, i) => loader(f.reader, `g${i}`));
  const seen = new Set<unknown>();
  all.forEach((l) => l.subscribe(() => seen.add(id(l))));
  all.forEach((l) => void l.reload());
  await flush();
  expect(t.names()).toEqual(['g0', 'g1']);
  await f.grants('ai');
  await flush();
  // The two old requests keep both slots: nothing new is sent yet.
  expect(t.names()).toEqual(['g0', 'g1']);
  t.answer('g0');
  t.answer('g1');
  while (
    t.pending.length ||
    !all.every((l) => l.getSnapshot().kind === 'ready')
  ) {
    await flush();
    if (t.pending.length) t.answer();
  }
  expect(t.maxima.perPod).toBe(2);
  // g0 and g1 once under each grant, the waiting reads only once.
  expect(t.dispatched).toHaveLength(7);
  for (const [i, l] of all.entries()) {
    const state = l.getSnapshot();
    const last = t.names().lastIndexOf(`g${i}`);
    if (state.kind === 'ready')
      expect(state.data[0]!['urn:dispatch']).toBe(last);
  }
  expect(seen.has('ready')).toBe(false);
});

it('a removed source drops its waiting reads at once; its running requests keep the shared capacity until they settle', async () => {
  const { f, runtime, other } = await twoPods(keep, {
    podReadLimit: { total: 2 },
  });
  const t = transport(f);
  const alice = runtime.bindPod(f.id);
  const bob = runtime.bindPod(other.id);
  const running = [
    alice.sparql.construct(query('a0')),
    alice.sparql.construct(query('a1')),
  ];
  await flush();
  const dropped = alice.sparql.construct(query('a2'));
  const waiting = bob.sparql.construct(query('b0'));
  await runtime.disconnect(f.id);
  expect(await Promise.all(running)).toEqual([
    { kind: 'invalidated' },
    { kind: 'invalidated' },
  ]);
  expect(await dropped).toEqual({ kind: 'invalidated' });
  await flush();
  expect(t.names()).toEqual(['a0', 'a1']);
  t.answer('a0');
  await flush();
  expect(t.names()).toEqual(['a0', 'a1', 'b0']);
  t.answer('b0');
  expect(await waiting).toMatchObject({ kind: 'ok' });
  t.answer('a1');
  await flush();
  expect(t.dispatched).toHaveLength(3);
});

it('the resend after a Bearer 401 stays in its slot; the renewal is not counted', async () => {
  const f = await session({ perPod: 1 });
  const t = transport(f, { first: unauthorized });
  const order: string[] = [];
  f.setToken(async () => {
    order.push('renewal');
    // Unchanged grants: the renewal keeps the read current.
    return Response.json({
      access_token: jwt({ scope: 'ai mcp' }),
      token_type: 'Bearer',
      refresh_token: 'rotated',
    });
  });
  const first = f.reader.sparql.construct(query('first'));
  const second = f.reader.sparql.construct(query('second'));
  await flush();
  t.answer('first'); // the 401
  await flush();
  expect(order).toEqual(['renewal']);
  expect(t.names()).toEqual(['first', 'first']);
  t.answer('first');
  expect(await first).toMatchObject({ kind: 'ok' });
  await flush();
  expect(t.names()).toEqual(['first', 'first', 'second']);
  t.answer('second');
  expect(await second).toMatchObject({ kind: 'ok' });
  expect(t.maxima.perPod).toBe(1);
});

it('a current read goes before older waiting reads, within the limit', async () => {
  const f = await session({ perPod: 1 });
  const t = transport(f);
  void f.reader.sparql.construct(query('blocker'));
  await flush();
  void f.reader.sparql.construct(query('older'));
  void f.reader.sparql.construct(query('current'), { priority: 'current' });
  await flush();
  expect(t.names()).toEqual(['blocker']);
  t.answer();
  await flush();
  expect(t.names()).toEqual(['blocker', 'current']);
  t.answer();
  await flush();
  expect(t.names()).toEqual(['blocker', 'current', 'older']);
  t.answer();
});

it('cancelling, disposing or aborting a waiting read sends nothing', async () => {
  const f = await session({ perPod: 1 });
  const t = transport(f);
  void f.reader.sparql.construct(query('blocker'));
  await flush();
  const cancelled = loader(f.reader, 'cancelled');
  const disposed = loader(f.reader, 'disposed');
  void cancelled.reload();
  void disposed.reload();
  const stop = new AbortController();
  const aborted = f.reader.sparql.construct(query('aborted'), {
    signal: stop.signal,
  });
  await flush();
  cancelled.cancel();
  disposed.dispose();
  stop.abort();
  expect(await aborted).toEqual({ kind: 'cancelled' });
  expect(cancelled.getSnapshot().kind).toBe('cancelled');
  t.answer('blocker');
  await flush();
  expect(t.names()).toEqual(['blocker']);
});

it('without podReadLimit every read starts at once', async () => {
  const f = await session(undefined);
  const t = transport(f);
  const all = Array.from({ length: 50 }, (_, i) => loader(f.reader, `u${i}`));
  all.forEach((l) => void l.reload());
  await flush();
  expect(t.dispatched).toHaveLength(50);
  while (t.pending.length) t.answer();
  await vi.waitFor(() =>
    expect(all.every((l) => l.getSnapshot().kind === 'ready')).toBe(true),
  );
});
