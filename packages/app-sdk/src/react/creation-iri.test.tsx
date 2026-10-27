// @vitest-environment jsdom
/** Known-IRI creation uses the same captured command and recovery as collections. */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { fields, text } from '@sempods/client-sdk/edit';
import type { JsonLd } from '@sempods/client-sdk';
import { bindCreation } from '../index.js';
import { SempodsProvider, useApp, useCreation } from './index.js';
import {
  catalogue,
  deferred,
  fixture,
  personal,
  resourceIri,
  work,
} from '../runtime/fixture.test.js';

const definition = fields({ title: text('urn:title', { language: null }) });
const cleanups: (() => void)[] = [];
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal(
    'ArrayBuffer',
    (await webcrypto.subtle.digest('SHA-256', new Uint8Array())).constructor,
  );
});
afterEach(() => {
  cleanup();
  cleanups.splice(0).forEach((stop) => stop());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function setup(context?: string) {
  const f = fixture();
  f.setCatalogue(async () => catalogue([work, personal], [work, personal]));
  const session = await f.login();
  cleanups.push(() => session.runtime.dispose());
  const writes: {
    iri: string;
    body: JsonLd;
    condition: string | null;
    context: string | null;
  }[] = [];
  const rows = new Map<string, JsonLd>();
  let answer: (() => Promise<Response>) | undefined;
  f.setResource(async (url, init) => {
    const iri = resourceIri(url);
    if ((init?.method ?? 'GET') === 'GET')
      return rows.has(iri)
        ? Response.json(rows.get(iri), { headers: { etag: '"v1"' } })
        : new Response(null, { status: 404 });
    expect(init?.method).toBe('PUT');
    const body = JSON.parse(init!.body as string) as JsonLd;
    writes.push({
      iri,
      body,
      condition: new Headers(init?.headers).get('if-none-match'),
      context: new URL(url).searchParams.get('context'),
    });
    if (answer) return answer();
    if (rows.has(iri)) return new Response(null, { status: 412 });
    rows.set(iri, body);
    return new Response(null, { status: 201 });
  });
  let first!: ReturnType<typeof useCreation<{ title: string }>>;
  let second!: typeof first;
  let app!: ReturnType<typeof useApp>;
  function Forms({ iri }: { iri: string }) {
    first = useCreation(definition, {
      iri,
      ...(context === undefined ? {} : { context }),
      initial: { title: '' },
    });
    second = useCreation(definition, {
      iri,
      ...(context === undefined ? {} : { context }),
      initial: { title: '' },
    });
    app = useApp();
    return null;
  }
  const host = (iri: string) => (
    <SempodsProvider runtime={session.runtime}>
      <Forms iri={iri} />
    </SempodsProvider>
  );
  const mounted = render(host('urn:settings'));
  await waitFor(() => expect(first.canEdit).toBe(true));
  return {
    ...f,
    ...session,
    writes,
    rows,
    first: () => first,
    second: () => second,
    app: () => app,
    address: (iri: string) => mounted.rerender(host(iri)),
    answer: (next?: () => Promise<Response>) => {
      answer = next;
    },
  };
}

it('creates at the exact IRI with a create-only condition and never overwrites it', async () => {
  const s = await setup();
  act(() => s.first().change({ title: 'Original' }));
  await act(async () =>
    expect(await s.first().create()).toEqual({
      kind: 'created',
      iri: 'urn:settings',
    }),
  );
  act(() => s.first().change({ title: 'Replacement' }));
  await act(async () =>
    expect(await s.first().create()).toMatchObject({
      kind: 'unconfirmed',
      iri: 'urn:settings',
      desiredObserved: false,
    }),
  );
  expect(s.writes.map((w) => [w.iri, w.condition])).toEqual([
    ['urn:settings', '*'],
    ['urn:settings', '*'],
  ]);
  expect(s.rows.get('urn:settings')?.['urn:title']).toEqual([
    { '@value': 'Original' },
  ]);
});

it('shares the pending/uncertain command and retries the captured IRI/body only after checking absence', async () => {
  const s = await setup();
  const held = deferred<Response>();
  s.answer(() => held.promise);
  act(() => s.first().change({ title: 'Captured' }));
  let sent!: ReturnType<ReturnType<typeof s.first>['create']>;
  act(() => {
    sent = s.first().create();
  });
  await waitFor(() => expect(s.second().busy).toBe(true));
  act(() => s.second().change({ title: 'Must not replace' }));
  expect(s.second().draft.title).toBe('Captured');
  expect(await s.second().create()).toEqual({
    kind: 'not-sent',
    reason: 'busy',
  });
  await act(async () => {
    held.resolve(new Response(null, { status: 202 }));
    await sent;
  });
  expect(await s.second().create()).toEqual({
    kind: 'not-sent',
    reason: 'unresolved',
  });
  await act(() => s.second().notice.onCheck());
  act(() => s.second().notice.onAcknowledge());
  expect(s.writes).toHaveLength(1);
  expect(s.first().canEdit).toBe(false);
  expect(s.first().canCreate).toBe(true);
  s.answer();
  await act(() => s.second().create());
  expect(s.writes).toHaveLength(2);
  expect(s.writes[1]).toEqual(s.writes[0]);
  expect(s.first().draft.title).toBe('');
});

it('does not retarget a retained command or a late answer when the IRI changes', async () => {
  const s = await setup();
  const held = deferred<Response>();
  s.answer(() => held.promise);
  act(() => s.first().change({ title: 'Old' }));
  const kept = s.first();
  let sent!: ReturnType<typeof kept.create>;
  act(() => {
    sent = kept.create();
  });
  await waitFor(() => expect(s.writes).toHaveLength(1));
  act(() => s.address('urn:other'));
  expect(s.first().draft.title).toBe('');
  expect(await kept.create()).toEqual({ kind: 'not-sent', reason: 'ended' });
  await act(async () => {
    held.resolve(new Response(null, { status: 202 }));
    await sent;
  });
  expect(s.first().outcome).toBeNull();
  expect(s.writes.map((w) => w.iri)).toEqual(['urn:settings']);
  act(() => s.address('urn:settings'));
  expect(s.first().outcome?.kind).toBe('unconfirmed');
  expect(s.first().draft.title).toBe('Old');
  expect(await kept.create()).toEqual({ kind: 'not-sent', reason: 'ended' });
});

it('keeps the exact IRI and explicit Context through selection changes', async () => {
  const s = await setup(work);
  act(() => s.first().change({ title: 'Settings' }));
  await act(async () =>
    expect(await s.app().selectContext(personal)).toBe(true),
  );
  await act(() => s.first().create());
  expect(s.writes).toMatchObject([
    { iri: 'urn:settings', context: work, condition: '*' },
  ]);
});

it('bindCreation captures a known IRI and immutable body for headless retries', async () => {
  const s = await setup();
  const draft = { title: 'Captured' };
  const command = bindCreation(
    s.runtime.bindContext(s.id, work),
    definition,
    draft,
    { iri: 'urn:headless' },
  );
  draft.title = 'Changed';
  s.answer(async () => new Response(null, { status: 202 }));
  expect(await command.run()).toEqual({ kind: 'unconfirmed' });
  s.answer();
  expect(await command.run()).toEqual({ kind: 'created' });
  expect(s.writes[1]).toEqual(s.writes[0]);
  expect(s.writes[0]).toMatchObject({
    iri: 'urn:headless',
    condition: '*',
    body: { 'urn:title': [{ '@value': 'Captured' }] },
  });
});

it('rejects missing or ambiguous creation addresses in JavaScript too', async () => {
  const s = await setup();
  const view = s.runtime.bindContext(s.id, work);
  // @ts-expect-error Exactly one address is required.
  expect(() => bindCreation(view, definition, { title: 'No' }, {})).toThrow(
    'exactly one',
  );
  expect(() =>
    bindCreation(
      view,
      definition,
      { title: 'Both' },
      // @ts-expect-error Both addresses are ambiguous.
      { iri: 'urn:settings', collection: 'tasks' },
    ),
  ).toThrow('exactly one');
  expect(s.writes).toHaveLength(0);
});

it('invalidates exact-IRI comparison evidence on read loss without replaying the command', async () => {
  const s = await setup();
  act(() => s.first().change({ title: 'Uncertain' }));
  s.answer(async () => new Response(null, { status: 202 }));
  await act(() => s.first().create());
  await act(() => s.first().notice.onCheck());
  expect(s.first().notice.checked).toBe(true);
  s.setCatalogue(async () => catalogue([personal], [personal]));
  await act(() => s.runtime.loadContexts(s.id));
  expect(s.first().notice.checked).toBe(false);
  expect(s.first().notice.current).toBeUndefined();
  act(() => s.first().notice.onAcknowledge());
  expect(s.first().outcome?.kind).toBe('unconfirmed');
  s.setCatalogue(async () => catalogue([work, personal], [work, personal]));
  await act(() => s.runtime.loadContexts(s.id));
  expect(s.first().canCreate).toBe(false);
  expect(s.writes).toHaveLength(1);
});
