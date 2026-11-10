// @vitest-environment jsdom
/**
 * The resource card recipe (#245) on two fixture Pods: reads per connection,
 * withdrawal, preview fallback and the read priority of the details.
 * Fixture evidence only: jsdom loads no image, and no real Pod answers.
 */
import { webcrypto } from 'node:crypto';
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
import { SdkLocaleProvider, SempodsProvider } from '@sempods/app-sdk/react';
import {
  CardDetails,
  CardList,
  ImagePreview,
  useResourceCards,
} from '../../../../examples/todo/recipes/resource-card-view.js';
import {
  MAX_ATTEMPTS,
  exampleRules,
} from '../../../../examples/todo/recipes/resource-cards.js';
import type { BrowserRuntime } from '../runtime/types.js';
import { deferred, pod, twoPods } from '../runtime/fixture.test.js';

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

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SAME_AS = 'http://www.w3.org/2002/07/owl#sameAs';
const S = 'https://schema.org/';
const ada = 'https://people.example/ada';
const lovelace = 'https://people.example/lovelace';

type Row = readonly [string, string, string | { literal: string }, string];
/** Statements per Pod; a card read gets those of its root. */
function answers(data: Readonly<Record<string, readonly Row[]>>): PodFetch {
  return async (url, init) => {
    const source = url.split('/_system')[0]!;
    const root = /GRAPH \?g \{ <([^>]+)>/.exec(String(init?.body))![1]!;
    const rows = (data[source] ?? []).filter(([s]) => s === root);
    return Response.json(
      {
        head: { vars: ['s', 'p', 'o', 'g'] },
        results: {
          bindings: rows.map(([s, p, o, g]) => ({
            s: { type: 'uri', value: s },
            p: { type: 'uri', value: p },
            o:
              typeof o === 'string'
                ? { type: 'uri', value: o }
                : { type: 'literal', value: o.literal },
            g: { type: 'uri', value: `${source}/_system/contexts/${g}` },
          })),
        },
      },
      { headers: { 'content-type': 'application/sparql-results+json' } },
    );
  };
}
const preview = (name: string) =>
  within(screen.getByRole('article', { name })).getAllByRole('img')[0]!;

it('merges both Pods, falls back between addresses and withdraws a source', async () => {
  const { f, runtime, other, otherUrl } = await twoPods(keep);
  f.setQuery(
    answers({
      [pod]: [
        [ada, RDF_TYPE, `${S}Person`, 'people'],
        [
          ada,
          `${S}image`,
          { literal: 'https://img.example/ada.jpg' },
          'people',
        ],
      ],
      [otherUrl]: [
        [ada, SAME_AS, lovelace, 'links'],
        [
          lovelace,
          `${S}image`,
          { literal: 'https://img.example/l.jpg' },
          'media',
        ],
      ],
    }),
  );
  render(
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <CardList runtime={runtime} roots={[ada, lovelace]} />
    </SempodsProvider>,
  );
  // One card for both roots, from both Pods.
  await waitFor(() =>
    expect(screen.getByRole('article', { name: 'ada' }).dataset['rule']).toBe(
      'person',
    ),
  );
  await waitFor(() =>
    expect(screen.queryByRole('article', { name: 'lovelace' })).toBeNull(),
  );
  const box = preview('ada');
  let image = box.querySelector('img')!;
  expect(box.getAttribute('aria-label')).toBe('Loading picture');
  expect(image.getAttribute('src')).toBe('https://img.example/ada.jpg');
  expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(image.getAttribute('loading')).toBe('lazy');
  expect(image.getAttribute('decoding')).toBe('async');
  expect(image.getAttribute('alt')).toBe('');
  expect(image.hasAttribute('crossorigin')).toBe(false);
  // A transport or decode failure tries the next address, once.
  fireEvent.error(image);
  image = box.querySelector('img')!;
  expect(image.getAttribute('src')).toBe('https://img.example/l.jpg');
  fireEvent.load(image);
  expect(box.getAttribute('aria-label')).toBe('Picture');
  // The SDK never requests an image address; the browser does.
  expect(f.fetch.mock.calls.some(([url]) => url.includes('img.example'))).toBe(
    false,
  );
  // Bob's Pod leaves: his alias and picture go, and so does the element.
  await act(() => runtime.disconnect(other.id));
  await waitFor(() =>
    expect(screen.getByRole('article', { name: 'lovelace' })).toBeTruthy(),
  );
  expect(preview('ada').querySelector('img')).toBeNull();
  expect(preview('ada').getAttribute('aria-label')).toBe('Picture unavailable');
  expect(preview('lovelace').getAttribute('aria-label')).toBe('No picture');
  // With no reading connection after startup, nothing is "absent".
  await act(() =>
    runtime.disconnect(runtime.getSnapshot().find((c) => c.podUrl === pod)!.id),
  );
  await waitFor(() =>
    expect(preview('lovelace').getAttribute('aria-label')).toBe(
      'Picture unavailable',
    ),
  );
});

it('tells unread, unavailable and absent pictures apart', async () => {
  const { f, runtime, otherUrl } = await twoPods(keep);
  const gate = deferred<void>();
  const data = answers({});
  const waiting: AbortSignal[] = [];
  const dropped: AbortSignal[] = [];
  f.setQuery(async (url, init) => {
    const body = String(init?.body);
    if (body.includes('unread')) {
      if (init?.signal) waiting.push(init.signal);
      return gate.promise.then(() => data(url, init));
    }
    if (body.includes('dropped')) {
      if (init?.signal) dropped.push(init.signal);
      return new Promise<Response>(() => {});
    }
    if (body.includes('refused') && url.startsWith(otherUrl))
      return new Response(null, { status: 403 });
    return data(url, init);
  });
  const list = (roots: readonly string[]) => (
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <CardList runtime={runtime} roots={roots} />
    </SempodsProvider>
  );
  const view = render(
    list(['urn:x:unread', 'urn:x:refused', 'urn:x:absent', 'urn:x:dropped']),
  );
  const label = (name: string) => preview(name).getAttribute('aria-label');
  await waitFor(() => expect(label('refused')).toBe('Picture unavailable'));
  await waitFor(() => expect(label('absent')).toBe('No picture'));
  expect(label('unread')).toBe('Not read yet');
  // A resource that is no longer admitted cancels its running reads.
  await waitFor(() =>
    expect([waiting, dropped]).toMatchObject([
      [{}, {}],
      [{}, {}],
    ]),
  );
  view.rerender(list(['urn:x:unread', 'urn:x:refused', 'urn:x:absent']));
  expect(screen.queryByRole('article', { name: 'dropped' })).toBeNull();
  await waitFor(() =>
    expect(dropped.map((signal) => signal.aborted)).toEqual([true, true]),
  );
  expect(waiting.map((signal) => signal.aborted)).toEqual([false, false]);
  // Once its read answers without a picture, it is absent too.
  gate.resolve();
  await waitFor(() => expect(label('unread')).toBe('No picture'));
});

it('reads the details before the waiting reads of the list', async () => {
  const { f, runtime } = await twoPods(keep, {
    podReadLimit: { perPod: 1 },
  });
  const sent: string[] = [];
  const held: (() => void)[] = [];
  const data = answers({});
  f.setQuery((url, init) => {
    // Only Alice's Pod is held; Bob's reads answer at once.
    if (!url.startsWith(pod + '/')) return data(url, init);
    sent.push(/<urn:x:(\w+)>/.exec(String(init?.body))![1]!);
    return new Promise((resolve) =>
      held.push(() => void data(url, init).then(resolve)),
    );
  });
  const roots = ['urn:x:a', 'urn:x:b', 'urn:x:c'];
  const view = render(
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <CardList runtime={runtime} roots={roots} />
    </SempodsProvider>,
  );
  await waitFor(() => expect(sent).toEqual(['a']));
  view.rerender(
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <CardList runtime={runtime} roots={roots} />
      <CardDetails runtime={runtime} root="urn:x:c" />
    </SempodsProvider>,
  );
  await act(async () => {
    held.shift()!();
    await Promise.resolve();
  });
  // The details' read of c goes before the list's waiting b and c.
  await waitFor(() => expect(sent).toEqual(['a', 'c']));
});

it('reads once per root and Pod with inline rules, again for new rules', async () => {
  const { f, runtime } = await twoPods(keep);
  const data = answers({});
  let reads = 0;
  let renders = 0;
  const queries: string[] = [];
  f.setQuery(async (url, init) => {
    reads++;
    queries.push(String(init?.body));
    return data(url, init);
  });
  function Inline({ only = false }: { readonly only?: boolean }) {
    renders++;
    // A new, equal array on every render.
    const { cards, readers } = useResourceCards(runtime, ['urn:x:a'], {
      rules: only ? exampleRules.slice(-1) : [...exampleRules],
    });
    return (
      <>
        {readers}
        <output>{cards.get('urn:x:a')?.rule}</output>
      </>
    );
  }
  const view = render(
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <Inline />
    </SempodsProvider>,
  );
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toBe('resource'),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const settledRenders = renders;
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(renders).toBe(settledRenders);
  expect(reads).toBe(2);
  // Other rules declare other predicates: each Pod reads the new query.
  view.rerender(
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <Inline only />
    </SempodsProvider>,
  );
  await waitFor(() => expect(reads).toBe(4));
  expect(queries[2]).not.toBe(queries[0]);
  expect(queries[2]).not.toContain('startDate');
});

it('shows a root that is no IRI as unavailable without reading it', async () => {
  const { f, runtime } = await twoPods(keep);
  const data = answers({});
  let reads = 0;
  f.setQuery(async (url, init) => {
    reads++;
    return data(url, init);
  });
  render(
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <CardList runtime={runtime} roots={['urn:x:bad>', 'urn:x:good']} />
    </SempodsProvider>,
  );
  await waitFor(() =>
    expect(preview('bad>').getAttribute('aria-label')).toBe(
      'Picture unavailable',
    ),
  );
  await waitFor(() =>
    expect(preview('good').getAttribute('aria-label')).toBe('No picture'),
  );
  expect(reads).toBe(2);
});

/** A card with the given pictures, each a list of variant addresses. */
const cardWith = (pictures: readonly (readonly string[])[], refused = 0) => ({
  root: 'urn:x:card',
  members: ['urn:x:card'],
  rule: 'resource',
  types: [],
  sameAs: [],
  images: pictures.map((variants) => ({
    variants: variants.map((value) => ({ value, evidence: [] })),
  })),
  dates: [],
  refused,
  truncated: false,
});
const settled = { unread: false, unavailable: false };
const at = (n: number) => `https://img.example/${n}.jpg`;

it('stops after six failed addresses, also when new ones arrive', () => {
  const pictures = [[at(1), at(2)], [at(3), at(4)], [at(5), at(6)], [at(7)]];
  const view = render(
    <SdkLocaleProvider language="en">
      <ImagePreview card={cardWith(pictures)} status={settled} />
    </SdkLocaleProvider>,
  );
  const box = screen.getByRole('img');
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    expect(box.querySelector('img')!.getAttribute('src')).toBe(at(n));
    fireEvent.error(box.querySelector('img')!);
  }
  expect(box.querySelector('img')).toBeNull();
  expect(box.getAttribute('aria-label')).toBe('Picture unavailable');
  view.rerender(
    <SdkLocaleProvider language="en">
      <ImagePreview card={cardWith([[at(0)], ...pictures])} status={settled} />
    </SdkLocaleProvider>,
  );
  expect(box.querySelector('img')).toBeNull();
});

it('keeps a loaded picture when a preferred one arrives', () => {
  const view = render(
    <SdkLocaleProvider language="en">
      <ImagePreview card={cardWith([[at(2)]])} status={settled} />
    </SdkLocaleProvider>,
  );
  const box = screen.getByRole('img');
  fireEvent.load(box.querySelector('img')!);
  view.rerender(
    <SdkLocaleProvider language="en">
      <ImagePreview card={cardWith([[at(1)], [at(2)]])} status={settled} />
    </SdkLocaleProvider>,
  );
  expect(box.querySelector('img')!.getAttribute('src')).toBe(at(2));
  expect(box.getAttribute('aria-label')).toBe('Picture');
});

it('shows a refused address as unavailable, not absent', () => {
  render(
    <SdkLocaleProvider language="en">
      <ImagePreview card={cardWith([], 1)} status={settled} />
    </SdkLocaleProvider>,
  );
  expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
    'Picture unavailable',
  );
});

it('starts the details preview afresh for another resource', async () => {
  const { f, runtime } = await twoPods(keep);
  // Both resources name the same address; only the first one tried it.
  const shared = { literal: 'https://img.example/shared.jpg' };
  f.setQuery(
    answers({
      [pod]: [
        ['urn:x:a', `${S}image`, shared, 'a'],
        ['urn:x:b', `${S}image`, shared, 'b'],
      ],
    }),
  );
  const details = (root: string) => (
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <CardDetails runtime={runtime} root={root} />
    </SempodsProvider>
  );
  const view = render(details('urn:x:a'));
  const box = () =>
    within(screen.getByRole('region', { name: /^[ab]$/ })).getAllByRole(
      'img',
    )[0]!;
  await waitFor(() => expect(box().querySelector('img')).toBeTruthy());
  fireEvent.error(box().querySelector('img')!);
  expect(box().getAttribute('aria-label')).toBe('Picture unavailable');
  view.rerender(details('urn:x:b'));
  await waitFor(() =>
    expect(screen.getByRole('region', { name: 'b' })).toBeTruthy(),
  );
  await waitFor(() =>
    expect(box().querySelector('img')?.getAttribute('src')).toBe(
      'https://img.example/shared.jpg',
    ),
  );
});
