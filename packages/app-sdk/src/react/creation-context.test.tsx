// @vitest-environment jsdom
/** Creating in an explicit Context (`useCreation` with `context`, `bindCreation`). */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { fields, text } from '@sempods/client-sdk/edit';
import {
  SempodsProvider,
  TargetScreen,
  UpdateNotice,
  useApp,
  useCreation,
  useList,
} from './index.js';
import { bindCreation } from '../index.js';
import { observeWrites, startCount } from '../authoring/changes.js';
import type { BrowserRuntime } from '../runtime/types.js';
import {
  catalogue,
  deferred,
  fixture,
  personal,
  pod,
  restored,
  work,
} from '../runtime/fixture.test.js';

const definition = fields(
  { title: text('urn:title', { language: null }) },
  {
    type: 'urn:Task',
  },
);
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

/** Signed in with `work` selected; both Contexts writable; PUTs answered by `answer`. */
async function signedIn(answer: () => Promise<Response> | Response) {
  const f = fixture();
  f.setCatalogue(async () => catalogue([work, personal], [work, personal]));
  const session = await f.login();
  runtimes.push(session.runtime);
  const puts: string[] = [];
  let respond = answer;
  f.setResource(async (url, init) => {
    if (init?.method === 'PUT') {
      puts.push(new URL(url).searchParams.get('context') ?? '');
      return respond();
    }
    return new Response(null, { status: 404 });
  });
  f.setQuery(async () => Response.json([]));
  return {
    ...f,
    ...session,
    puts,
    answer: (next: typeof answer) => {
      respond = next;
    },
  };
}

const outcomes: unknown[] = [];
const results: boolean[] = [];
function Form({ context }: { readonly context: string }) {
  const creation = useCreation(definition, {
    initial: { title: '' },
    collection: 'tasks',
    context,
  });
  const app = useApp();
  return (
    <>
      <input
        aria-label="Title"
        disabled={!creation.canEdit}
        value={creation.draft.title}
        onChange={(e) => creation.change({ title: e.target.value })}
      />
      <button
        disabled={!creation.canCreate}
        onClick={() => void creation.create().then((o) => outcomes.push(o))}
      >
        Create
      </button>
      <output aria-label="refused">{String(creation.refused)}</output>
      <UpdateNotice {...creation.notice} />
      <button
        onClick={() =>
          void app.selectContext(personal).then((r) => results.push(r))
        }
      >
        Select personal
      </button>
      <button
        onClick={() => void app.navigate(() => {}).then((r) => results.push(r))}
      >
        Open a row
      </button>
    </>
  );
}
function Reads() {
  const list = useList(definition);
  return <output aria-label="list">{list.state.kind}</output>;
}
function App({
  runtime,
  context,
}: {
  readonly runtime: BrowserRuntime;
  readonly context: string;
}) {
  return (
    <SempodsProvider runtime={runtime}>
      <Form context={context} />
      <TargetScreen>
        <Reads />
      </TargetScreen>
    </SempodsProvider>
  );
}
const title = () => screen.getByLabelText('Title') as HTMLInputElement;
async function type(value: string) {
  await waitFor(() => expect(title().disabled).toBe(false));
  fireEvent.change(title(), { target: { value } });
}
const create = () => screen.getByRole('button', { name: 'Create' });

it('creates in a Context that is not the selected one and reports the new IRI', async () => {
  outcomes.length = 0;
  const f = await signedIn(() => new Response(null, { status: 201 }));
  render(<App runtime={f.runtime} context={personal} />);
  await type('Private');
  await waitFor(() =>
    expect((create() as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(create());
  await waitFor(() => expect(outcomes).toHaveLength(1));
  expect(f.puts).toEqual([personal]);
  expect(outcomes[0]).toMatchObject({ kind: 'created' });
  expect((outcomes[0] as { iri: string }).iri).toMatch(
    new RegExp('^' + pod + '/tasks/'),
  );
  expect(title().value).toBe('');
  // The selection is unchanged.
  expect(f.runtime.getSnapshot()[0]?.selectedContext).toBe(work);
});

it('refreshes a list of the same Context after an explicit creation', async () => {
  const f = await signedIn(() => new Response(null, { status: 201 }));
  render(<App runtime={f.runtime} context={work} />);
  await waitFor(() =>
    expect(screen.getByLabelText('list').textContent).toBe('ready'),
  );
  const before = f.count('/_system/sparql/query');
  await type('Shared');
  await waitFor(() =>
    expect((create() as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(create());
  await waitFor(
    () => expect(f.count('/_system/sparql/query')).toBeGreaterThan(before),
    { timeout: 5000 },
  );
});

it('reports a refused Context and creates nothing there', async () => {
  const f = await signedIn(() => new Response(null, { status: 201 }));
  render(<App runtime={f.runtime} context={pod + '/tasks/not-a-context'} />);
  await waitFor(() =>
    expect(screen.getByLabelText('refused').textContent).toBe('true'),
  );
  expect(title().disabled).toBe(true);
  expect((create() as HTMLButtonElement).disabled).toBe(true);
  expect(f.puts).toEqual([]);
});

it('keeps the draft of a refused write and shows the refusal', async () => {
  const f = await signedIn(() => new Response(null, { status: 403 }));
  render(<App runtime={f.runtime} context={personal} />);
  await type('Kept');
  await waitFor(() =>
    expect((create() as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(create());
  expect(
    await screen.findByText(
      'The change was not saved. Check access and try again.',
    ),
  ).toBeTruthy();
  expect(title().value).toBe('Kept');
});

it('keeps its target through a Context selection while a creation is pending, unconfirmed after', async () => {
  outcomes.length = 0;
  results.length = 0;
  const held = deferred<Response>();
  const f = await signedIn(() => held.promise);
  render(<App runtime={f.runtime} context={personal} />);
  await type('Pending');
  await waitFor(() =>
    expect((create() as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(create());
  await waitFor(() => expect(f.puts).toEqual([personal]));
  // The pending creation does not block selecting another Context.
  fireEvent.click(screen.getByRole('button', { name: 'Select personal' }));
  await waitFor(() => expect(results).toEqual([true]));
  expect(f.runtime.getSnapshot()[0]?.selectedContext).toBe(personal);
  // A lost answer stays unconfirmed in this Context, never resent.
  await act(async () => held.resolve(new Response(null, { status: 202 })));
  expect(await screen.findByText(/The result is unconfirmed/)).toBeTruthy();
  expect(f.puts).toEqual([personal]);
  expect(title().value).toBe('Pending');
});

it('keeps an unsaved draft through row navigation and Context selection without asking', async () => {
  results.length = 0;
  const f = await signedIn(() => new Response(null, { status: 201 }));
  render(<App runtime={f.runtime} context={personal} />);
  await type('Unsaved');
  fireEvent.click(screen.getByRole('button', { name: 'Open a row' }));
  await waitFor(() => expect(results).toEqual([true]));
  fireEvent.click(screen.getByRole('button', { name: 'Select personal' }));
  await waitFor(() => expect(results).toEqual([true, true]));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(title().value).toBe('Unsaved');
});

it('bindCreation creates headless in an explicit Context and counts as its write', async () => {
  const f = await signedIn(() => new Response(null, { status: 201 }));
  const view = f.runtime.bindContext(f.id, work);
  const writes = vi.fn();
  const stop = observeWrites(view, writes);
  const starts = startCount(view);
  const creation = bindCreation(
    view,
    definition,
    { title: 'Headless' },
    { collection: 'tasks' },
  );
  expect(creation.iri).toMatch(new RegExp('^' + pod + '/tasks/'));
  expect(await creation.run()).toEqual({ kind: 'created' });
  stop();
  expect(f.puts).toEqual([work]);
  // Lists of this Context read again; earlier success feedback there retires.
  expect(writes).toHaveBeenCalledTimes(1);
  expect(startCount(view)).toBe(starts + 1);
});

it('binds the Context again after a re-authorization resumes from the back/forward cache', async () => {
  outcomes.length = 0;
  const page = new EventTarget();
  vi.stubGlobal('addEventListener', page.addEventListener.bind(page));
  vi.stubGlobal('removeEventListener', page.removeEventListener.bind(page));
  const f = await signedIn(() => new Response(null, { status: 201 }));
  render(<App runtime={f.runtime} context={personal} />);
  await waitFor(() => expect(title().disabled).toBe(false));
  await act(() => f.runtime.beginAuthorization(f.id));
  await act(async () => {
    page.dispatchEvent(
      Object.assign(new Event('pageshow'), { persisted: true }),
    );
    await restored(f.runtime);
  });
  await type('After return');
  await waitFor(() =>
    expect((create() as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(create());
  await waitFor(() => expect(outcomes).toHaveLength(1));
  expect(outcomes[0]).toMatchObject({ kind: 'created' });
  expect(f.puts).toEqual([personal]);
});
