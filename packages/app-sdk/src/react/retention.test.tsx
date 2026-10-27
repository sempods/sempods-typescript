// @vitest-environment jsdom
/** Lists that reload without blanking, and quiet success (#104). */
import { webcrypto } from 'node:crypto';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fields, flag, text } from '@sempods/client-sdk/edit';
import type { JsonLd } from '@sempods/client-sdk';
import {
  fixture,
  deferred,
  personal,
  resourceIri,
} from '../runtime/fixture.test.js';
import {
  LoadNotice,
  SempodsProvider,
  TargetScreen,
  UpdateNotice,
  useApp,
  useCreation,
  useFieldUpdate,
  useList,
} from './index.js';

const definition = fields(
  {
    title: text('urn:title', { language: null }),
    done: flag('urn:status', { on: 'urn:done', off: 'urn:open' }),
  },
  { type: 'urn:Task' },
);
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
  cleanups.splice(0).forEach((f) => f());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const task = (iri: string, title: string, done = false): JsonLd => ({
  '@id': iri,
  '@type': ['urn:Task'],
  'urn:title': [{ '@value': title }],
  'urn:status': [{ '@id': done ? 'urn:done' : 'urn:open' }],
});

async function setup(retain?: boolean) {
  const f = fixture();
  const session = await f.login();
  cleanups.push(() => session.runtime.dispose());
  const rows = new Map<string, JsonLd>([['urn:one', task('urn:one', 'One')]]);
  let held: ReturnType<typeof deferred<void>> | undefined;
  let lose = false;
  f.setQuery(async () => {
    await held?.promise;
    return Response.json([...rows.values()]);
  });
  f.setResource(async (url, init) => {
    const iri = resourceIri(url);
    const method = init?.method ?? 'GET';
    if (method === 'GET')
      return rows.has(iri)
        ? Response.json(rows.get(iri), { headers: { etag: '"v1"' } })
        : new Response(null, { status: 404 });
    if (lose) throw new TypeError('lost answer');
    const body = JSON.parse(init!.body as string) as JsonLd;
    rows.set(iri, { ...rows.get(iri), ...body });
    return new Response(null, { status: method === 'PUT' ? 201 : 204 });
  });
  let api!: {
    list: ReturnType<typeof useList<{ title: string; done: boolean }>>;
    creation: ReturnType<typeof useCreation<{ title: string; done: boolean }>>;
    update: ReturnType<typeof useFieldUpdate<{ title: string; done: boolean }>>;
    app: ReturnType<typeof useApp>;
  };
  function Screen() {
    // Without an option, as apps write it: rows are retained by default.
    const list = useList(definition, retain === undefined ? {} : { retain });
    const creation = useCreation(definition, {
      initial: { title: '', done: false },
      collection: 'tasks',
    });
    const update = useFieldUpdate(definition);
    api = { list, creation, update, app: useApp() };
    return (
      <>
        <LoadNotice {...list} />
        <UpdateNotice {...creation.notice} quiet />
        <UpdateNotice {...update.for('urn:one').notice} quiet />
        <output aria-label="state">{list.state.kind}</output>
        <ul>
          {list.data?.items.map((row) => (
            <li key={row.iri}>{row.data.title}</li>
          ))}
        </ul>
      </>
    );
  }
  render(
    <SempodsProvider runtime={session.runtime}>
      <TargetScreen>
        <Screen />
      </TargetScreen>
    </SempodsProvider>,
  );
  await screen.findByText('One');
  return {
    f,
    session,
    rows,
    api: () => api,
    hold() {
      held = deferred<void>();
      return held;
    },
    lose(value: boolean) {
      lose = value;
    },
  };
}
const titles = () =>
  screen.queryAllByRole('listitem').map((li) => li.textContent);
const status = () => screen.getByLabelText('state').textContent;

it('keeps the rows while a confirmed creation refreshes the list, quietly', async () => {
  const s = await setup();
  const gate = s.hold();
  await act(async () => {
    s.api().creation.change({ title: 'Two', done: false });
    await s.api().creation.create();
  });
  // The refresh runs: the old rows stay, and "Created." stays quiet.
  expect(status()).toBe('loading');
  expect(titles()).toEqual(['One']);
  expect(screen.queryByText('Created.')).toBeNull();
  await act(async () => gate.resolve());
  await waitFor(() => expect(titles()).toEqual(['One', 'Two']));
  expect(screen.queryByText('Created.')).toBeNull();
});

it('keeps readable rows after a failed refresh, distinguishable, and retries', async () => {
  const s = await setup();
  s.f.setQuery(async () => new Response(null, { status: 500 }));
  await act(async () => {
    await s.api().list.reload();
  });
  expect(status()).toBe('failed');
  expect(titles()).toEqual(['One']);
  expect(screen.getByRole('alert').textContent).toMatch(
    / What is shown may be out of date\.$/,
  );
  s.f.setQuery(async () => Response.json([...s.rows.values()]));
  await act(async () =>
    screen.getByRole('button', { name: 'Try again' }).click(),
  );
  await waitFor(() => expect(status()).toBe('ready'));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('names a cancelled read and entries it cannot show, and retries', async () => {
  const s = await setup();
  // An empty required title reads, but no update could write it back.
  s.rows.set('urn:empty', task('urn:empty', ''));
  s.hold();
  await act(async () => {
    void s.api().list.reload();
  });
  await act(async () => s.api().list.cancel());
  expect(status()).toBe('cancelled');
  expect(screen.getByText('Loading was cancelled.')).toBeTruthy();
  s.f.setQuery(async () => Response.json([...s.rows.values()]));
  await act(async () =>
    screen.getByRole('button', { name: 'Try again' }).click(),
  );
  expect(await screen.findByText('One entry cannot be shown.')).toBeTruthy();
  expect(titles()).toEqual(['One']);
});

it('clears retained rows for another Context', async () => {
  const s = await setup();
  s.hold();
  await act(async () => {
    await s.api().app.selectContext(personal);
  });
  expect(status()).toBe('loading');
  expect(titles()).toEqual([]);
});

it('blanks a reload without retain, as before', async () => {
  const s = await setup(false);
  s.hold();
  await act(async () => {
    void s.api().list.reload();
  });
  expect(status()).toBe('loading');
  expect(titles()).toEqual([]);
});

it('still shows an unconfirmed row update with quiet success, never replayed', async () => {
  const s = await setup();
  const row = s.api().list.state;
  const first = row.kind === 'ready' ? row.data.items[0] : undefined;
  if (!first) throw new Error('no row');
  s.lose(true);
  const writes = () =>
    s.f.fetch.mock.calls.filter(
      ([url, init]) =>
        url.includes('/_system/resources/') && init?.method === 'PATCH',
    ).length;
  await act(async () => {
    await s.api().update.for(first).update({ done: true });
  });
  expect(writes()).toBe(1);
  expect(await screen.findByText(/The result is unconfirmed/)).toBeTruthy();
  // The list shows only what a read returned: no optimistic row.
  expect(titles()).toEqual(['One']);
  expect(s.rows.get('urn:one')).toEqual(task('urn:one', 'One'));
  s.lose(false);
  await act(async () => {
    await s.api().list.reload();
  });
  expect(writes()).toBe(1);
});

it('drops retained rows when the definition changes', async () => {
  const f = fixture();
  const session = await f.login();
  cleanups.push(() => session.runtime.dispose());
  const held: { gate?: ReturnType<typeof deferred<void>> } = {};
  f.setQuery(async () => {
    await held.gate?.promise;
    return Response.json([task('urn:one', 'One')]);
  });
  const seen: string[] = [];
  function Rows({ language }: { readonly language: string | null }) {
    const list = useList(
      fields({ title: text('urn:title', { language }) }, { type: 'urn:Task' }),
      { retain: true },
    );
    seen.push(list.state.kind + ('previous' in list.state ? '+previous' : ''));
    return <output aria-label="state">{list.state.kind}</output>;
  }
  const view = render(
    <SempodsProvider runtime={session.runtime}>
      <TargetScreen>
        <Rows language={null} />
      </TargetScreen>
    </SempodsProvider>,
  );
  await waitFor(() => expect(status()).toBe('ready'));
  held.gate = deferred<void>();
  seen.length = 0;
  view.rerender(
    <SempodsProvider runtime={session.runtime}>
      <TargetScreen>
        <Rows language="de" />
      </TargetScreen>
    </SempodsProvider>,
  );
  await waitFor(() => expect(status()).toBe('loading'));
  expect(seen).not.toContain('loading+previous');
  await act(async () => held.gate!.resolve());
  await waitFor(() => expect(status()).toBe('ready'));
});
