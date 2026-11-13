// @vitest-environment jsdom
/**
 * Recovery comparisons show structured draft values (#306): a `TextVariant`
 * keeps its language and every value of a conflict, missing and empty read
 * apart, and other structures never collapse to `[object Object]`. The
 * editor's evidence, acknowledgement and conditional writes are unchanged.
 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import {
  editTextVariant,
  patchTextVariant,
  selectTextVariant,
  type EditDefinition,
  type LanguageOrder,
  type TextVariant,
} from '@sempods/client-sdk/edit';
import type { JsonLd } from '@sempods/client-sdk';
import {
  ResourceEditor,
  SempodsProvider,
  TargetScreen,
  UpdateNotice,
  useResourceEditor,
  useSelection,
} from './index.js';
import type { BrowserRuntime } from '../runtime/types.js';
import { englishMessages } from '../locale.js';
import { fixture, resourceIri } from '../runtime/fixture.test.js';

const NAME = 'https://schema.org/name';
const NOTE = 'https://schema.org/description';
const order: LanguageOrder = ['de', 'en', '*'];

interface Task {
  readonly name: TextVariant;
  readonly note: TextVariant;
}
const definition: EditDefinition<Task> = {
  read: (resource) => ({
    name: selectTextVariant(resource, NAME, order),
    note: selectTextVariant(resource, NOTE, order),
  }),
  patch: (resource, draft) => ({
    ...patchTextVariant(resource, NAME, draft.name),
    ...patchTextVariant(resource, NOTE, draft.note),
  }),
};

const UNCONFIRMED = englishMessages.controls.unconfirmed;
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

type Terms = readonly { readonly '@value': string; '@language'?: string }[];
/** A task on the Pod whose write answers as `write` says. */
async function setup(write: 'conflict' | 'lost', language?: 'de') {
  const f = fixture();
  const session = await f.login();
  runtimes.push(session.runtime);
  let version = 1;
  let name: Terms = [{ '@value': 'Einkauf', '@language': 'de' }];
  let note: Terms = [];
  const writes: string[] = [];
  f.setResource(async (url, init) => {
    if ((init?.method ?? 'GET') === 'GET')
      return resourceIri(url) === 'urn:one'
        ? Response.json(
            {
              '@id': 'urn:one',
              '@type': ['urn:Task'],
              [NAME]: [...name],
              ...(note.length > 0 ? { [NOTE]: [...note] } : {}),
            } satisfies JsonLd,
            { headers: { etag: `"v${version}"` } },
          )
        : new Response(null, { status: 404 });
    writes.push(String(init?.body));
    // Someone else stored a second German name meanwhile and left no note.
    version++;
    name = [
      { '@value': 'Einkauf', '@language': 'de' },
      { '@value': 'Großeinkauf', '@language': 'de' },
    ];
    note = [];
    if (write === 'lost') throw new TypeError('Failed to fetch');
    return new Response(null, { status: 412 });
  });
  function Screen() {
    const selection = useSelection<string>();
    const editor = useResourceEditor(selection.selected, definition);
    if (!selection.selected)
      return (
        <button onClick={() => void selection.select('urn:one')}>Open</button>
      );
    return (
      <ResourceEditor editor={editor} labels={{ name: 'Name', note: 'Note' }}>
        {(draft, change) => (
          <>
            <label>
              Name
              <input
                value={draft.name.value ?? ''}
                onChange={(e) =>
                  change({
                    ...draft,
                    name: editTextVariant(draft.name, e.target.value),
                  })
                }
              />
            </label>
            <button
              onClick={() =>
                change({ ...draft, note: editTextVariant(draft.note, '') })
              }
            >
              Empty note
            </button>
          </>
        )}
      </ResourceEditor>
    );
  }
  render(
    <SempodsProvider
      runtime={session.runtime}
      {...(language ? { language } : {})}
    >
      <TargetScreen>
        <Screen />
      </TargetScreen>
    </SempodsProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
  const field = (await screen.findByLabelText('Name')) as HTMLInputElement;
  return { field, writes };
}

/** Each field of a comparison as `label: shown text`, with language tags. */
function rows(list: Element) {
  return [...list.querySelectorAll(':scope > div')].map(
    (row) =>
      `${row.querySelector('dt')!.textContent}: ${row.querySelector('dd')!.textContent}`,
  );
}

it.each(['conflict', 'lost'] as const)(
  'a %s write compares text variants with their language, conflicts and missing vs empty text',
  async (write) => {
    const { field, writes } = await setup(write);
    fireEvent.change(field, { target: { value: 'Wocheneinkauf' } });
    fireEvent.click(screen.getByRole('button', { name: 'Empty note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    const review = await screen.findByRole('region', {
      name: 'The pod has changed. Compare before continuing.',
    });
    expect(within(review).getByRole('alert').textContent).toBe(
      write === 'conflict'
        ? 'The pod has changed. Compare before continuing.'
        : UNCONFIRMED,
    );
    await waitFor(() =>
      expect(
        review.querySelectorAll('dl[data-sempods-ui="comparison"]'),
      ).toHaveLength(2),
    );
    const [mine, current] = [
      ...review.querySelectorAll('dl[data-sempods-ui="comparison"]'),
    ];
    // The stored draft keeps its TextVariant; nothing reads [object Object].
    expect(review.textContent).not.toContain('[object Object]');
    expect(rows(mine!)).toEqual([
      'Name: Wocheneinkauf · de',
      'Note: Empty text · de',
    ]);
    await waitFor(() =>
      expect(rows(current!)).toEqual([
        'Name: Several values in this language · deEinkaufGroßeinkauf',
        'Note: No value · de',
      ]),
    );
    // Every value of the conflict is listed, in its language.
    const conflict = [...current!.querySelectorAll('li > span')];
    expect(
      conflict.map((v) => [v.textContent, v.getAttribute('lang')]),
    ).toEqual([
      ['Einkauf', 'de'],
      ['Großeinkauf', 'de'],
    ]);
    // Missing and empty read apart and are not tagged as German text.
    expect(mine!.querySelector('.sp-sdk-none')?.hasAttribute('lang')).toBe(
      false,
    );
    expect(current!.querySelector('.sp-sdk-none')?.textContent).toBe(
      'No value',
    );
    // The SDK still owns the decision: continuing keeps the draft, writes nothing.
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with my changes' }),
    );
    expect(writes).toHaveLength(1);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(
      'Wocheneinkauf',
    );
  },
);

it('the review comparison is localized', async () => {
  const { field, writes } = await setup('conflict', 'de');
  fireEvent.change(field, { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  const review = await screen.findByRole('region', {
    name: 'Der Pod wurde geändert. Vergleiche vor dem Fortfahren.',
  });
  await waitFor(() =>
    expect(
      [...review.querySelectorAll('dl[data-sempods-ui="comparison"]')].map(
        rows,
      ),
    ).toEqual([
      ['Name: Leerer Text · de', 'Note: Kein Wert · de'],
      [
        'Name: Mehrere Werte in dieser Sprache · deEinkaufGroßeinkauf',
        'Note: Kein Wert · de',
      ],
    ]),
  );
});

it('UpdateNotice shows missing, empty and structured values apart', () => {
  const f = fixture();
  runtimes.push(f.runtime);
  const untagged: TextVariant = {
    language: null,
    value: 'Plain',
    values: ['Plain'],
    ambiguous: false,
  };
  render(
    <SempodsProvider runtime={f.runtime} timeZone="UTC">
      <UpdateNotice
        outcome={{ kind: 'unconfirmed' }}
        current={{
          missing: undefined,
          absent: null,
          empty: '',
          untagged,
          tags: ['a', '', null],
          none: [],
          nested: { start: 1.5, open: true },
          due: new Date(Date.UTC(2026, 10, 13, 9, 30)),
          exact: new Date(Date.UTC(2026, 10, 13, 9, 30, 15, 250)),
        }}
        labels={{ untagged: 'Title' }}
      />
    </SempodsProvider>,
  );
  const list = screen
    .getByRole('region')
    .querySelector('dl[data-sempods-ui="comparison"]')!;
  expect(rows(list)).toEqual([
    'missing: No value',
    'absent: No value',
    'empty: Empty text',
    // Untagged text has no language tag and no lang attribute.
    'Title: Plain',
    'tags: aEmpty textNo value',
    'none: No value',
    'nested: start1.5openYes',
    'due: Nov 13, 2026, 9:30 AM',
    // A locale form would drop the seconds; the exact instant stays.
    'exact: 2026-11-13T09:30:15.250Z',
  ]);
  expect(list.querySelector('[lang]')).toBeNull();
  expect(list.textContent).not.toContain('[object Object]');
});

it('a review lists a field the current version lacks as no value', async () => {
  const f = fixture();
  const session = await f.login();
  runtimes.push(session.runtime);
  // A custom editor whose current version omits a draft field.
  const state = {
    phase: 'review' as const,
    draft: { title: 'Mine', note: 'Kept' },
    dirty: true,
    valid: true,
    canSave: false,
    canRemove: false,
    canDiscard: true,
    problem: null,
    review: {
      kind: 'changed-on-pod' as const,
      intent: 'save' as const,
      mine: { title: 'Mine', note: 'Kept' },
      current: { title: 'Theirs' } as { title: string; note: string },
    },
  };
  const editor = {
    iri: 'urn:one',
    state,
    loaded: Promise.resolve(state),
    subscribe: () => () => {},
    change: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
    discard: vi.fn(),
    refresh: vi.fn(),
    continueFromCurrent: vi.fn(),
    setAccess: vi.fn(),
    dispose: vi.fn(),
  };
  render(
    <SempodsProvider runtime={session.runtime}>
      <ResourceEditor editor={editor}>{() => null}</ResourceEditor>
    </SempodsProvider>,
  );
  await act(async () => {});
  expect(
    [...document.querySelectorAll('dl[data-sempods-ui="comparison"]')].map(
      rows,
    ),
  ).toEqual([
    ['title: Mine', 'note: Kept'],
    ['title: Theirs', 'note: No value'],
  ]);
});
