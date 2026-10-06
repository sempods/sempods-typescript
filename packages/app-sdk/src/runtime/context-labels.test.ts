import { afterEach, expect, it, vi } from 'vitest';
import type { PodFetch } from '@sempods/client-sdk';
import type { BrowserRuntime, BrowserRuntimeOptions } from './types.js';
import { createBrowserRuntime } from './runtime.js';
import {
  catalogue,
  deferred,
  fixture,
  personal,
  pod,
  work,
  settleLease,
  restored,
  jwt,
} from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
afterEach(() => runtimes.splice(0).forEach((r) => r.dispose()));
const sd = 'http://www.w3.org/ns/sparql-service-description#';
function description(iri: string, label?: string) {
  return Response.json({
    '@id': iri,
    '@type': [`${sd}NamedGraph`],
    [`${sd}name`]: [{ '@id': iri }],
    'https://schema.sempods.org/public': [{ '@value': false }],
    ...(label
      ? { 'http://www.w3.org/2000/01/rdf-schema#label': [{ '@value': label }] }
      : {}),
  });
}
const labels = (runtime: BrowserRuntime) => {
  const fact = runtime.getSnapshot()[0]!.catalogue;
  return 'labels' in fact ? fact.labels : undefined;
};
const descriptions = (f: ReturnType<typeof fixture>) =>
  f.fetch.mock.calls.filter(([url]) =>
    /\/_system\/contexts\/[^/]+$/.test(new URL(url).pathname),
  );
async function signedIn(f: ReturnType<typeof fixture>) {
  runtimes.push(f.runtime);
  const { connection } = await f.begin();
  f.runtime.dispose();
  await settleLease();
  const runtime = f.returned();
  runtimes.push(runtime);
  await runtime.initialize();
  return { runtime, id: connection.id };
}
async function selected(f = fixture({ preferences: null })) {
  const result = await signedIn(f);
  await result.runtime.loadContexts(result.id);
  result.runtime.selectContext(result.id, work);
  return { ...f, ...result };
}

it('loads labels and cancels stale selection requests without AbortSignal.any', async () => {
  const native = Object.getOwnPropertyDescriptor(AbortSignal, 'any')!;
  Object.defineProperty(AbortSignal, 'any', { value: undefined });
  try {
    const f = fixture({ preferences: null });
    const stale = deferred<Response>();
    let signal: AbortSignal | undefined;
    f.setDescriptions(async (url, init) => {
      if (url === work) {
        signal = init?.signal ?? undefined;
        return stale.promise;
      }
      return description(url, 'Current');
    });
    const { runtime, id } = await selected(f);
    await vi.waitFor(() => expect(signal).toBeDefined());
    runtime.selectContext(id, personal);
    expect(signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(labels(runtime)?.[personal]).toBe('Current'));
    stale.resolve(description(work, 'Stale'));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(labels(runtime)).toEqual({ [personal]: 'Current' });
  } finally {
    Object.defineProperty(AbortSignal, 'any', native);
  }
});

it.each([1, 50, 51, 10_000])(
  'loads only the selected Context in a catalogue of %i entries',
  async (size) => {
    const f = fixture({ preferences: null });
    const iris = [
      work,
      ...Array.from(
        { length: size - 1 },
        (_, i) => `${pod}/_system/contexts/c${i}`,
      ),
    ];
    f.setCatalogue(async () => catalogue(iris, [work]));
    f.setDescriptions(async (url) => description(url, 'Selected'));
    const { runtime, id } = await signedIn(f);
    await runtime.loadContexts(id);
    expect(descriptions(f)).toHaveLength(0);
    runtime.selectContext(id, work);
    await vi.waitFor(() =>
      expect(labels(runtime)).toEqual({ [work]: 'Selected' }),
    );
    expect(descriptions(f).map(([url]) => url)).toEqual([work]);
    expect(runtime.getSnapshot()[0]!.selectedContext).toBe(work);
  },
);

it('coalesces a pending selected-label read and caches it through catalogue reloads and reselection', async () => {
  const f = fixture({ preferences: null });
  const gate = deferred<Response>();
  f.setDescriptions((url) =>
    url === work ? gate.promise : Promise.resolve(description(url, 'Private')),
  );
  const { runtime, id } = await selected(f);
  await vi.waitFor(() => expect(descriptions(f)).toHaveLength(1));
  runtime.selectContext(id, work);
  await Promise.all([runtime.loadContexts(id), runtime.loadContexts(id)]);
  expect(descriptions(f)).toHaveLength(1);
  gate.resolve(description(work, 'Work'));
  await vi.waitFor(() => expect(labels(runtime)).toEqual({ [work]: 'Work' }));
  runtime.selectContext(id, personal);
  await vi.waitFor(() => expect(labels(runtime)?.[personal]).toBe('Private'));
  runtime.selectContext(id, work);
  await runtime.loadContexts(id);
  expect(descriptions(f).map(([url]) => url)).toEqual([work, personal]);
});

it('ignores stale results after rapid A-B-A selection even if the transport ignores abort', async () => {
  const f = fixture({ preferences: null });
  const calls: {
    url: string;
    signal: AbortSignal | undefined;
    gate: ReturnType<typeof deferred<Response>>;
  }[] = [];
  f.setDescriptions((url, init) => {
    const gate = deferred<Response>();
    calls.push({ url, signal: init?.signal ?? undefined, gate });
    return gate.promise;
  });
  const { runtime, id } = await selected(f);
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  runtime.selectContext(id, personal);
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  runtime.selectContext(id, work);
  await vi.waitFor(() => expect(calls).toHaveLength(3));
  expect(calls[0]!.signal?.aborted).toBe(true);
  expect(calls[1]!.signal?.aborted).toBe(true);
  calls[2]!.gate.resolve(description(work, 'Current'));
  await vi.waitFor(() =>
    expect(labels(runtime)).toEqual({ [work]: 'Current' }),
  );
  calls[0]!.gate.resolve(description(work, 'Old'));
  calls[1]!.gate.resolve(description(personal, 'Stale'));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(labels(runtime)).toEqual({ [work]: 'Current' });
});

it.each(['network', 'refused', 'absent'] as const)(
  'keeps fallback after %s without blocking Pod reads or retrying',
  async (mode) => {
    const f = fixture({ preferences: null });
    const handler: PodFetch = async (url) => {
      if (mode === 'network') throw new TypeError('offline');
      if (mode === 'refused') return new Response(null, { status: 403 });
      return description(url);
    };
    f.setDescriptions(handler);
    const { runtime, id } = await selected(f);
    await vi.waitFor(() => expect(descriptions(f)).toHaveLength(1));
    // Let the settled attempt enter the failure/absence cache before repeating demand.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await runtime.loadContexts(id);
    runtime.selectContext(id, work);
    const reader = runtime.bindPod(id);
    expect(
      await reader.sparql.construct(
        'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
      ),
    ).toMatchObject({ kind: 'ok' });
    expect(labels(runtime)).toBeUndefined();
    expect(descriptions(f)).toHaveLength(1);
    expect(runtime.getSnapshot()[0]!.selectedContext).toBe(work);
  },
);

it.each(['preset', 'remembered'] as const)(
  'loads the validated %s Context without explicit reselection',
  async (mode) => {
    const map = new Map<string, string>();
    const preferences = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
    };
    const options: Partial<BrowserRuntimeOptions> =
      mode === 'preset'
        ? { preset: { podUrl: pod, contextIri: work }, preferences: null }
        : { preferences };
    const f = fixture(options);
    f.setDescriptions(async (url) => description(url, 'Restored'));
    const result = await selected(f);
    await vi.waitFor(() =>
      expect(labels(result.runtime)?.[work]).toBe('Restored'),
    );
    result.runtime.dispose();
    await settleLease();
    const next = createBrowserRuntime({
      ...f.options,
      location: () => 'https://app.example/',
    });
    runtimes.push(next);
    await next.initialize();
    await restored(next);
    expect(descriptions(f)).toHaveLength(1);
    expect(next.getSnapshot()[0]!.selectedContext).toBeNull();
    await next.loadContexts(result.id);
    await vi.waitFor(() => expect(labels(next)?.[work]).toBe('Restored'));
    expect(next.getSnapshot()[0]!.selectedContext).toBe(work);
    expect(descriptions(f).map(([url]) => url)).toEqual([work, work]);
  },
);

it('drops revoked label authority and rereads it on restored permission', async () => {
  const f = fixture({ preferences: null });
  f.setDescriptions(async (url) => description(url, 'Original'));
  const { runtime, id } = await selected(f);
  await vi.waitFor(() => expect(labels(runtime)?.[work]).toBe('Original'));
  f.setCatalogue(async () => catalogue([personal], []));
  await runtime.loadContexts(id);
  expect(labels(runtime)).toBeUndefined();
  f.setDescriptions(async (url) => description(url, 'Fresh'));
  f.setCatalogue(async () => catalogue());
  await runtime.loadContexts(id);
  await vi.waitFor(() => expect(labels(runtime)?.[work]).toBe('Fresh'));
  expect(descriptions(f).map(([url]) => url)).toEqual([work, work]);
});

it.each(['disconnect', 'dispose', 'reauthorize', 'scope-loss'] as const)(
  'retires pending and cached label authority on %s',
  async (mode) => {
    const f = fixture({ preferences: null, scopes: { optional: ['ai'] } });
    f.setToken(async () =>
      Response.json({
        access_token: jwt({ scope: 'ai' }),
        token_type: 'Bearer',
        refresh_token: 'initial',
      }),
    );
    const gates: ReturnType<typeof deferred<Response>>[] = [];
    let signal: AbortSignal | undefined;
    f.setDescriptions((_url, init) => {
      signal ??= init?.signal ?? undefined;
      const gate = deferred<Response>();
      gates.push(gate);
      return gate.promise;
    });
    const { runtime, id } = await selected(f);
    await vi.waitFor(() => expect(descriptions(f)).toHaveLength(1));
    if (mode === 'disconnect') await runtime.disconnect(id);
    else if (mode === 'dispose') runtime.dispose();
    else if (mode === 'reauthorize') await runtime.beginAuthorization(id);
    else {
      let calls = 0;
      f.setQuery(async () =>
        ++calls === 1
          ? new Response(null, {
              status: 401,
              headers: { 'www-authenticate': 'Bearer' },
            })
          : Response.json([]),
      );
      f.setToken(async () =>
        Response.json({
          access_token: jwt(),
          token_type: 'Bearer',
          refresh_token: 'rotated',
        }),
      );
      await runtime
        .bindPod(id)
        .sparql.construct('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }');
    }
    expect(signal?.aborted).toBe(true);
    gates[0]!.resolve(description(work, 'Stale'));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (runtime.getSnapshot().length) expect(labels(runtime)).toBeUndefined();
    if (mode === 'scope-loss') {
      await vi.waitFor(() => expect(gates).toHaveLength(2));
      gates[1]!.resolve(description(work, 'Fresh'));
      await vi.waitFor(() => expect(labels(runtime)?.[work]).toBe('Fresh'));
      expect(descriptions(f).map(([url]) => url)).toEqual([work, work]);
    }
  },
);

it.each(['ready', 'refused', 'offline'] as const)(
  'does not restore cached labels across a scope change during a %s catalogue reload',
  async (mode) => {
    const f = fixture({ preferences: null, scopes: { optional: ['ai'] } });
    f.setToken(async () =>
      Response.json({
        access_token: jwt({ scope: 'ai' }),
        token_type: 'Bearer',
        refresh_token: 'initial',
      }),
    );
    f.setDescriptions(async (url) => description(url, 'Old authority'));
    const { runtime, id } = await selected(f);
    await vi.waitFor(() =>
      expect(labels(runtime)?.[work]).toBe('Old authority'),
    );
    const gate = deferred<Response>();
    f.setCatalogue(() => gate.promise);
    const reload = runtime.loadContexts(id);
    // Attach before rejecting the gate to avoid an unhandled rejection.
    const settled = reload.catch(() => {});
    await vi.waitFor(() =>
      expect(runtime.getSnapshot()[0]!.catalogue.kind).toBe('loading'),
    );
    let calls = 0;
    f.setQuery(async () =>
      ++calls === 1
        ? new Response(null, {
            status: 401,
            headers: { 'www-authenticate': 'Bearer' },
          })
        : Response.json([]),
    );
    f.setToken(async () =>
      Response.json({
        access_token: jwt(),
        token_type: 'Bearer',
        refresh_token: 'rotated',
      }),
    );
    await runtime.bindPod(id).sparql.construct('CONSTRUCT {} WHERE {}');
    expect(labels(runtime)).toBeUndefined();
    f.setDescriptions(async (url) => description(url, 'New authority'));
    if (mode === 'offline') gate.reject(new TypeError('offline'));
    else
      gate.resolve(
        mode === 'ready' ? catalogue() : new Response(null, { status: 403 }),
      );
    await settled;
    if (mode === 'ready')
      await vi.waitFor(() =>
        expect(labels(runtime)?.[work]).toBe('New authority'),
      );
    else expect(labels(runtime)).toBeUndefined();
  },
);
