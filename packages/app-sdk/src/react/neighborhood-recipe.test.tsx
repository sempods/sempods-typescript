// @vitest-environment jsdom
/**
 * The neighborhood recipe (#292) on two fixture Pods whose SPARQL answers come
 * from the Oxigraph engine: bounded requests, load more, failures and retry,
 * withdrawal and obsolete answers. Fixture evidence only: no real Pod answers.
 */
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PodFetch } from '@sempods/client-sdk';
import { SempodsProvider } from '@sempods/app-sdk/react';
import { NeighborhoodList } from '../../../../examples/todo/recipes/neighborhood-view.js';
import {
  PAGE_SIZE,
  type Area,
} from '../../../../examples/todo/recipes/neighborhood.js';
import type { BrowserRuntime } from '../runtime/types.js';
import { deferred, pod, twoPods } from '../runtime/fixture.test.js';

interface OxigraphStore {
  load(input: string, options: { readonly format: string }): void;
  query(query: string, options: { readonly results_format: string }): unknown;
}
const { Store } = createRequire(import.meta.url)('oxigraph') as {
  readonly Store: new () => OxigraphStore;
};

const runtimes: BrowserRuntime[] = [];
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal(
    'ArrayBuffer',
    (await webcrypto.subtle.digest('SHA-256', new Uint8Array())).constructor,
  );
});
afterEach(() => {
  cleanup();
  runtimes.splice(0).forEach((r) => r.dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const keep = (runtime: BrowserRuntime) => void runtimes.push(runtime);

const bob = 'https://pod.example/bob';
const ada = 'https://people.example/ada';
const lovelace = 'https://people.example/lovelace';
const P = 'urn:p:';
const ctx = (owner: string, name: string) =>
  `${owner}/_system/contexts/${name}`;

/** `count` statements of one dense incoming kind, then two other kinds. */
function statements(owner: string, root = ada, count = 60) {
  const g = (name: string) => `<${ctx(owner, name)}>`;
  // The other ends name the root, so that two roots' statements differ.
  const name = root.split('/').at(-1)!;
  return [
    ...Array.from(
      { length: count },
      (_, i) =>
        `<https://people.example/${name}-f${String(i).padStart(3, '0')}> <${P}a-follows> <${root}> ${g('people')} .`,
    ),
    `<https://people.example/${name}-fan> <${P}likes> <${root}> ${g('z-notes')} .`,
    `<${root}> <${P}name> "Ada"@en ${g('z-notes')} .`,
  ].join('\n');
}

type Kind = 'page' | 'kinds' | 'examples';
interface Sent {
  readonly pod: string;
  readonly kind: Kind;
  readonly query: string;
  readonly signal: AbortSignal | undefined;
}
const kindOf = (query: string): Kind =>
  query.includes('UNION') || query.includes('VALUES ?p')
    ? 'examples'
    : query.startsWith('SELECT DISTINCT ?p ')
      ? 'kinds'
      : 'page';

/**
 * Each Pod answers from its own Oxigraph store. `hold` may delay or replace
 * an answer; every request is recorded.
 */
function engines(
  data: Readonly<Record<string, string>>,
  hold?: (sent: Sent, answer: () => Promise<Response>) => Promise<Response>,
) {
  const stores = new Map(
    Object.entries(data).map(([owner, nquads]) => {
      const store = new Store();
      store.load(nquads, { format: 'application/n-quads' });
      return [owner, store];
    }),
  );
  const sent: Sent[] = [];
  const fetch: PodFetch = async (url, init) => {
    const owner = url.split('/_system')[0]!;
    const query = String(init?.body);
    const entry = {
      pod: owner,
      kind: kindOf(query),
      query,
      signal: init?.signal ?? undefined,
    };
    sent.push(entry);
    const answer = async () =>
      new Response(
        stores.get(owner)!.query(query, {
          results_format: 'application/sparql-results+json',
        }) as string,
        { headers: { 'content-type': 'application/sparql-results+json' } },
      );
    return hold ? hold(entry, answer) : answer();
  };
  const count = (owner: string, kind?: Kind) =>
    sent.filter((s) => s.pod === owner && (!kind || s.kind === kind)).length;
  return { fetch, sent, count };
}

function show(runtime: BrowserRuntime, root = ada, hidden?: readonly Area[]) {
  return (
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <NeighborhoodList
        runtime={runtime}
        root={root}
        {...(hidden ? { hidden } : {})}
      />
    </SempodsProvider>
  );
}
const listed = () =>
  within(screen.getByRole('list', { name: 'Statements' }))
    .queryAllByRole('listitem')
    .map((item) => item.textContent!);
const examples = () => {
  const region = screen.queryByRole('region', {
    name: 'Examples',
  });
  return region
    ? within(region)
        .getAllByRole('listitem')
        .map((item) => item.textContent!)
    : [];
};
const controls = (owner: string, direction: 'incoming' | 'outgoing') =>
  within(screen.getByRole('group', { name: `${owner} ${direction}` }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
/** The Pod and Context a listed statement names, compared exactly. */
const sourceOf = (text: string) => {
  const [before = '', context = ''] = text.split(' · ');
  return { pod: before.split(' ').at(-1), context };
};
const fromPod = (owner: string) => (text: string) =>
  sourceOf(text).pod === owner;
const inContext = (context: string) => (text: string) =>
  sourceOf(text).context === context;
/** The resource a query reads around, compared exactly. */
const rootOf = (query: string) =>
  /GRAPH \?g \{ (?:<([^>]+)> \?p \?other|\?other \?p <([^>]+)>) \}/
    .exec(query)
    ?.slice(1)
    .find(Boolean);

it('samples both Pods in bounded requests and keeps pages and examples apart', async () => {
  const { f, runtime } = await twoPods(keep);
  const answers = engines({ [pod]: statements(pod), [bob]: statements(bob) });
  f.setQuery(answers.fetch);
  render(show(runtime));
  await waitFor(() => expect(examples()).toHaveLength(2));
  await settle();
  // Per Pod: the first page of each direction, then two sample queries for
  // the cut incoming page. A complete page never starts a sample.
  for (const owner of [pod, bob]) {
    expect(answers.count(owner, 'page')).toBe(2);
    expect(answers.count(owner, 'kinds')).toBe(1);
    expect(answers.count(owner, 'examples')).toBe(1);
  }
  expect(listed()).toHaveLength(2 * PAGE_SIZE + 2);
  // Outgoing pages are complete: `name` is an ordinary statement there.
  expect(listed().filter((text) => text.includes(`${P}name`))).toHaveLength(2);
  // Examples keep the exact term, the direction, the Pod and the Context.
  expect(examples()).toContain(
    `incoming <${P}likes> <https://people.example/ada-fan> ${pod} · ${ctx(pod, 'z-notes')}`,
  );
  // The first page shows `a-follows`: the sample never repeats a kind.
  expect(examples()).toContain(
    `incoming <${P}likes> <https://people.example/ada-fan> ${bob} · ${ctx(bob, 'z-notes')}`,
  );
  expect(
    controls(pod, 'incoming').getByRole('button', { name: 'Load more' }),
  ).toBeTruthy();
  expect(controls(pod, 'outgoing').queryByRole('button')).toBeNull();
});

it('loads more pages without another sample, and the pages replace the examples', async () => {
  const { f, runtime } = await twoPods(keep);
  const answers = engines({ [pod]: statements(pod), [bob]: statements(bob) });
  f.setQuery(answers.fetch);
  render(show(runtime));
  await waitFor(() => expect(examples()).toHaveLength(2));
  const more = controls(pod, 'incoming').getByRole('button', {
    name: 'Load more',
  });
  // A double click reads one page.
  fireEvent.click(more);
  fireEvent.click(more);
  await waitFor(() =>
    expect(controls(pod, 'incoming').queryByRole('button')).toBeNull(),
  );
  await settle();
  expect(answers.count(pod, 'page')).toBe(3);
  expect(answers.count(pod, 'kinds')).toBe(1);
  expect(answers.count(pod, 'examples')).toBe(1);
  // Alice's pages are complete: her examples are ordinary statements now,
  // each once. Bob's examples stay.
  expect(listed()).toHaveLength(60 + 2 + PAGE_SIZE + 1);
  expect(listed().filter(inContext(ctx(pod, 'z-notes')))).toHaveLength(2);
  expect(examples()).toEqual([
    `incoming <${P}likes> <https://people.example/ada-fan> ${bob} · ${ctx(bob, 'z-notes')}`,
  ]);
});

it('keeps the page when the sample fails, and retries each read alone', async () => {
  const { f, runtime } = await twoPods(keep);
  let failSample = true;
  let failPage = true;
  const answers = engines(
    { [pod]: statements(pod), [bob]: statements(bob) },
    (sent, answer) => {
      if (sent.pod === bob && sent.kind === 'kinds' && failSample) {
        failSample = false;
        return Promise.resolve(new Response(null, { status: 500 }));
      }
      if (
        sent.pod === pod &&
        sent.kind === 'page' &&
        sent.query.includes('?other ?p <') &&
        rootOf(sent.query) === ada &&
        failPage
      ) {
        failPage = false;
        return Promise.resolve(new Response(null, { status: 500 }));
      }
      return answer();
    },
  );
  f.setQuery(answers.fetch);
  render(show(runtime));
  // Bob's page is usable without its sample; Alice's outgoing page without
  // her incoming one.
  const retrySample = await waitFor(() =>
    controls(bob, 'incoming').getByRole('button', { name: 'Retry examples' }),
  );
  const retryPage = await waitFor(() =>
    controls(pod, 'incoming').getByRole('button', { name: 'Retry' }),
  );
  expect(listed().filter(fromPod(bob))).toHaveLength(PAGE_SIZE + 1);
  expect(listed().filter(fromPod(pod))).toHaveLength(1);
  expect(examples()).toEqual([]);
  const before = answers.sent.length;
  fireEvent.click(retrySample);
  await waitFor(() => expect(examples()).toHaveLength(1));
  // The retry reads Bob's sample again, and nothing else.
  expect(answers.sent.slice(before).map((s) => [s.pod, s.kind])).toEqual([
    [bob, 'kinds'],
    [bob, 'examples'],
  ]);
  fireEvent.click(retryPage);
  await waitFor(() => expect(examples()).toHaveLength(2));
  expect(answers.sent.slice(before + 2).map((s) => [s.pod, s.kind])).toEqual([
    [pod, 'page'],
    [pod, 'kinds'],
    [pod, 'examples'],
  ]);
});

it('withdraws a source, and never shows an obsolete answer', async () => {
  const { f, runtime, other } = await twoPods(keep);
  const gate = deferred<void>();
  const answers = engines(
    {
      [pod]: `${statements(pod)}\n${statements(pod, lovelace)}`,
      [bob]: statements(bob),
    },
    async (sent, answer) => {
      // Alice's examples for ada wait until the root has changed.
      if (
        sent.pod === pod &&
        sent.kind === 'examples' &&
        rootOf(sent.query) === ada
      )
        await gate.promise;
      return answer();
    },
  );
  f.setQuery(answers.fetch);
  const view = render(show(runtime));
  await waitFor(() => expect(examples()).toHaveLength(1));
  expect(examples().map(fromPod(bob))).toEqual([true]);
  // Bob's Pod leaves: his statements and examples go in the same render.
  await act(() => runtime.disconnect(other.id));
  await waitFor(() => expect(examples()).toEqual([]));
  expect(listed().some(fromPod(bob))).toBe(false);
  // The person moves on while Alice's examples for ada are still pending.
  view.rerender(show(runtime, lovelace));
  await waitFor(() =>
    expect(listed().some((text) => text.includes('lovelace-f'))).toBe(true),
  );
  const pending = answers.sent.find(
    (s) => s.kind === 'examples' && rootOf(s.query) === ada,
  )!;
  expect(pending.signal?.aborted).toBe(true);
  gate.resolve();
  await waitFor(() => expect(examples()).toHaveLength(1));
  await settle();
  expect(listed().some((text) => text.includes('/ada-'))).toBe(false);
  expect(examples()).toEqual([
    `incoming <${P}likes> <https://people.example/lovelace-fan> ${pod} · ${ctx(pod, 'z-notes')}`,
  ]);
});

it('hides a Context at once and samples again without it, pages unchanged', async () => {
  const { f, runtime } = await twoPods(keep);
  const answers = engines({ [pod]: statements(pod), [bob]: statements(bob) });
  f.setQuery(answers.fetch);
  const view = render(show(runtime));
  await waitFor(() => expect(examples()).toHaveLength(2));
  await settle();
  const pages = answers.count(pod, 'page');
  const hidden = [{ pod, context: ctx(pod, 'z-notes') }];
  view.rerender(show(runtime, ada, hidden));
  // Hidden statements leave in the same render.
  expect(examples().some(inContext(ctx(pod, 'z-notes')))).toBe(false);
  expect(listed().some(inContext(ctx(pod, 'z-notes')))).toBe(false);
  await waitFor(() => expect(answers.count(pod, 'kinds')).toBe(2));
  const kinds = answers.sent.filter((s) => s.pod === pod && s.kind === 'kinds');
  expect(kinds[1]!.query).toContain(
    `FILTER(?g NOT IN (<${ctx(pod, 'z-notes')}>))`,
  );
  await settle();
  // Neither the pages nor the other Pod read again; Alice has no other kind.
  expect(answers.count(pod, 'page')).toBe(pages);
  expect(answers.count(bob, 'kinds')).toBe(1);
  expect(answers.count(pod, 'examples')).toBe(1);
  expect(examples()).toHaveLength(1);
  expect(examples().map(fromPod(bob))).toEqual([true]);
  // An equal inline array reads nothing again.
  view.rerender(show(runtime, ada, [...hidden]));
  await settle();
  expect(answers.count(pod, 'kinds')).toBe(2);
});

it('sends pages and samples through the shared read admission', async () => {
  const { f, runtime } = await twoPods(keep, { podReadLimit: { perPod: 1 } });
  const running = new Map<string, number>();
  let most = 0;
  const answers = engines(
    { [pod]: statements(pod), [bob]: statements(bob) },
    async (sent, answer) => {
      const now = (running.get(sent.pod) ?? 0) + 1;
      running.set(sent.pod, now);
      most = Math.max(most, now);
      await settle();
      running.set(sent.pod, now - 1);
      return answer();
    },
  );
  f.setQuery(answers.fetch);
  render(show(runtime));
  await waitFor(() => expect(examples()).toHaveLength(2));
  expect(most).toBe(1);
  expect(answers.sent).toHaveLength(8);
});
