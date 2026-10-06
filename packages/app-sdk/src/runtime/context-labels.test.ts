import { expect, it, vi } from 'vitest';
import type { PodFetch } from '@sempods/client-sdk';
import {
  catalogue,
  deferred,
  fixture,
  personal,
  pod,
  work,
} from './fixture.test.js';

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
const labelled =
  (labels: Record<string, string>): PodFetch =>
  async (url) =>
    url in labels || url === work || url === personal
      ? description(url, labels[url])
      : new Response(null, { status: 404 });

it('publishes registry labels after a ready catalogue, without touching contexts or selection', async () => {
  const f = fixture();
  f.setDescriptions(labelled({ [work]: 'Arbeit' }));
  const { runtime, id } = await f.login();
  await vi.waitFor(() => {
    const fact = runtime.getSnapshot()[0]!.catalogue;
    expect(fact.kind === 'ready' && fact.labels).toEqual({ [work]: 'Arbeit' });
  });
  const connection = runtime.getSnapshot()[0]!;
  expect(connection.id).toBe(id);
  expect(connection.selectedContext).toBe(work);
  expect(
    connection.catalogue.kind === 'ready' && connection.catalogue.contexts,
  ).toEqual([
    { iri: work, readable: true, writable: true, manageable: false },
    { iri: personal, readable: true, writable: false, manageable: false },
  ]);
  runtime.dispose();
});

it('tolerates failed reads, keeps labels while reloading and renews them on refresh', async () => {
  const f = fixture();
  f.setDescriptions(labelled({ [work]: 'Arbeit', [personal]: 'Privat' }));
  const { runtime, id } = await f.login();
  await vi.waitFor(() => {
    const fact = runtime.getSnapshot()[0]!.catalogue;
    expect(fact.kind === 'ready' && fact.labels).toEqual({
      [work]: 'Arbeit',
      [personal]: 'Privat',
    });
  });
  // Reloading keeps the known labels until the new ones are read.
  const reload = deferred<Response>();
  f.setCatalogue(() => reload.promise);
  const refresh = runtime.loadContexts(id);
  await vi.waitFor(() =>
    expect(runtime.getSnapshot()[0]!.catalogue).toMatchObject({
      kind: 'loading',
      labels: { [work]: 'Arbeit', [personal]: 'Privat' },
    }),
  );
  // One description fails, one changed: the failed one is simply left out.
  f.setDescriptions(async (url) => {
    if (url === personal) throw new Error('network');
    return description(url, 'Büro');
  });
  reload.resolve(catalogue());
  await refresh;
  await vi.waitFor(() => {
    const fact = runtime.getSnapshot()[0]!.catalogue;
    expect(fact.kind === 'ready' && fact.labels).toEqual({ [work]: 'Büro' });
  });
  runtime.dispose();
});

it('reads at most three descriptions at once and publishes nothing after disconnect', async () => {
  const f = fixture();
  const many = Array.from(
    { length: 60 },
    (_, i) => `${pod}/_system/contexts/c${i}`,
  );
  f.setCatalogue(async () => catalogue([work, ...many], [work]));
  const gate = deferred<void>();
  let open = 0;
  let peak = 0;
  f.setDescriptions(async (url) => {
    open++;
    peak = Math.max(peak, open);
    await gate.promise;
    open--;
    return description(url, 'x');
  });
  const { runtime, id } = await f.login();
  await vi.waitFor(() => expect(open).toBe(3));
  const snapshots: unknown[] = [];
  runtime.subscribe(() => snapshots.push(runtime.getSnapshot()));
  await runtime.disconnect(id);
  const afterDisconnect = snapshots.length;
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(peak).toBe(3);
  // The reads stop with the connection; nothing is published for it afterwards.
  expect(f.count('/_system/contexts/c59')).toBe(0);
  expect(snapshots.length).toBe(afterDisconnect);
  expect(runtime.getSnapshot()).toEqual([]);
  runtime.dispose();
});

it('caps the reads at 50 contexts per catalogue', async () => {
  const f = fixture();
  const many = Array.from(
    { length: 60 },
    (_, i) => `${pod}/_system/contexts/c${i}`,
  );
  f.setCatalogue(async () => catalogue([work, ...many], [work]));
  f.setDescriptions(async (url) => description(url, url.split('/').at(-1)));
  const { runtime } = await f.login();
  await vi.waitFor(() => {
    const fact = runtime.getSnapshot()[0]!.catalogue;
    expect(fact.kind === 'ready' && Object.keys(fact.labels ?? {}).length).toBe(
      50,
    );
  });
  const reads = f.fetch.mock.calls.filter(([url]) =>
    /\/_system\/contexts\/[^/]+$/.test(new URL(url).pathname),
  ).length;
  expect(reads).toBe(50);
  runtime.dispose();
});

it('drops labels of contexts the refreshed catalogue no longer lists', async () => {
  const f = fixture();
  f.setDescriptions(labelled({ [work]: 'Arbeit', [personal]: 'Privat' }));
  const { runtime, id } = await f.login();
  await vi.waitFor(() => {
    const fact = runtime.getSnapshot()[0]!.catalogue;
    expect(
      fact.kind === 'ready' && Object.keys(fact.labels ?? {}),
    ).toHaveLength(2);
  });
  // A valid empty catalogue carries no labels; a smaller one only its own.
  f.setCatalogue(async () => catalogue([], []));
  await runtime.loadContexts(id);
  expect(runtime.getSnapshot()[0]!.catalogue).toEqual({
    kind: 'ready',
    contexts: [],
  });
  f.setCatalogue(async () => catalogue([work], [work]));
  f.setDescriptions(async () => new Response(null, { status: 404 }));
  await runtime.loadContexts(id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const fact = runtime.getSnapshot()[0]!.catalogue;
  expect(fact.kind === 'ready' && fact.labels).toBeFalsy();
  runtime.dispose();
});

it('stops a superseded loader instead of reading on in parallel', async () => {
  const f = fixture();
  const many = Array.from(
    { length: 20 },
    (_, i) => `${pod}/_system/contexts/c${i}`,
  );
  f.setCatalogue(async () => catalogue([work, ...many], [work]));
  const gates: Array<() => void> = [];
  let released = false;
  let open = 0;
  let peak = 0;
  f.setDescriptions(async (url) => {
    open++;
    peak = Math.max(peak, open);
    if (!released) await new Promise<void>((resolve) => gates.push(resolve));
    open--;
    return description(url, 'x');
  });
  const { runtime, id } = await f.login();
  await vi.waitFor(() => expect(open).toBe(3));
  // A refresh while the first loader's reads are pending supersedes it.
  await runtime.loadContexts(id);
  await vi.waitFor(() => expect(gates.length).toBe(6));
  released = true;
  while (gates.length) gates.shift()!();
  await vi.waitFor(() => {
    const fact = runtime.getSnapshot()[0]!.catalogue;
    expect(
      fact.kind === 'ready' && Object.keys(fact.labels ?? {}),
    ).toHaveLength(21);
  });
  // The old loader finished only its in-flight reads, then stopped.
  const reads = f.fetch.mock.calls.filter(([url]) =>
    /\/_system\/contexts\/[^/]+$/.test(new URL(url).pathname),
  ).length;
  expect(reads).toBe(3 + 21);
  expect(peak).toBeLessThanOrEqual(6);
  runtime.dispose();
});
