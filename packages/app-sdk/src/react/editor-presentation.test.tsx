// @vitest-environment jsdom
/**
 * `ResourceEditor`'s frame is chosen independently of `onClose` (#191): the
 * same close, save and recovery behaviour in a row card and on a plain screen.
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
} from '@testing-library/react';
import { fields, text } from '@sempods/client-sdk/edit';
import type { JsonLd } from '@sempods/client-sdk';
import {
  ResourceEditor,
  SempodsProvider,
  TargetScreen,
  useResourceEditor,
  useSelection,
} from './index.js';
import type { BrowserRuntime } from '../runtime/types.js';
import { fixture, resourceIri } from '../runtime/fixture.test.js';

const definition = fields(
  { title: text('urn:title', { language: null }) },
  { type: 'urn:Task' },
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

type Props = Pick<Parameters<typeof ResourceEditor>[0], 'presentation'> & {
  readonly closable: boolean;
};

async function setup(props: Props) {
  const f = fixture();
  const session = await f.login();
  runtimes.push(session.runtime);
  let version = 1;
  let answer = 204;
  let title = 'One';
  const writes: string[] = [];
  f.setResource(async (url, init) => {
    if ((init?.method ?? 'GET') === 'GET')
      return resourceIri(url) === 'urn:one'
        ? Response.json(
            {
              '@id': 'urn:one',
              '@type': ['urn:Task'],
              'urn:title': [{ '@value': title }],
            } satisfies JsonLd,
            { headers: { etag: `"v${version}"` } },
          )
        : new Response(null, { status: 404 });
    writes.push(init?.method ?? '');
    if (answer === 204) {
      version++;
      const patch = JSON.parse(String(init?.body)) as JsonLd;
      title = (patch['urn:title'] as [{ '@value': string }])[0]['@value'];
    }
    return new Response(null, { status: answer });
  });
  const api = {} as { selection: ReturnType<typeof useSelection<string>> };
  function Screen() {
    api.selection = useSelection();
    const editor = useResourceEditor(api.selection.selected, definition);
    if (!api.selection.selected) return <p>Closed</p>;
    return (
      <ResourceEditor
        editor={editor}
        {...(props.presentation ? { presentation: props.presentation } : {})}
        {...(props.closable
          ? { onClose: () => void api.selection.select(null) }
          : {})}
      >
        {(draft, change) => (
          <>
            <label>
              Title
              <input
                value={draft.title}
                onChange={(e) => change({ title: e.target.value })}
              />
            </label>
            <div role="group" aria-label="Custom control" />
          </>
        )}
      </ResourceEditor>
    );
  }
  render(
    <SempodsProvider runtime={session.runtime}>
      <TargetScreen>
        <Screen />
      </TargetScreen>
    </SempodsProvider>,
  );
  await waitFor(() => expect(api.selection).toBeDefined());
  await act(async () => {
    expect(await api.selection.select('urn:one')).toBe(true);
  });
  const field = (await screen.findByLabelText('Title')) as HTMLInputElement;
  return {
    field,
    editor: field.closest('[data-sempods-ui="editor"]')!,
    writes,
    answer: (status: number) => {
      answer = status;
    },
  };
}

it('a plain editor keeps the close semantics of onClose without the card', async () => {
  const { field, editor, writes } = await setup({
    presentation: 'plain',
    closable: true,
  });
  expect(editor.hasAttribute('data-inline')).toBe(false);
  expect(editor.getAttribute('data-presentation')).toBe('plain');
  // onClose still decides the actions: Cancel, not Discard changes.
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Discard changes' })).toBeNull();
  fireEvent.change(field, { target: { value: 'Changed' } });
  fireEvent.keyDown(field, { key: 'Escape' });
  await screen.findByText('Closed');
  expect(writes).toEqual([]);
});

it('a plain editor stays open with the draft on a conflict', async () => {
  const { field, writes, answer } = await setup({
    presentation: 'plain',
    closable: true,
  });
  answer(412);
  fireEvent.change(field, { target: { value: 'Mine' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(writes).toEqual(['PATCH']));
  await screen.findAllByRole('alert');
  expect(screen.queryByText('Closed')).toBeNull();
  expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe(
    'Mine',
  );
});

it('the card stays the default with onClose and can frame an editor without it', async () => {
  const closable = await setup({ closable: true });
  expect(closable.editor.hasAttribute('data-inline')).toBe(true);
  expect(closable.editor.hasAttribute('data-presentation')).toBe(false);
  cleanup();
  const card = await setup({ presentation: 'card', closable: false });
  expect(card.editor.hasAttribute('data-inline')).toBe(true);
  // Without onClose the actions and Escape stay those of an editor in place.
  expect(screen.getByRole('button', { name: 'Discard changes' })).toBeTruthy();
  fireEvent.change(card.field, { target: { value: 'Changed' } });
  fireEvent.keyDown(card.field, { key: 'Escape' });
  expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe(
    'Changed',
  );
  cleanup();
  const unframed = await setup({ closable: false });
  expect(unframed.editor.hasAttribute('data-inline')).toBe(false);
  expect(unframed.editor.hasAttribute('data-presentation')).toBe(false);
});

it('a plain editor closes after a confirmed save', async () => {
  const { field, writes } = await setup({
    presentation: 'plain',
    closable: true,
  });
  fireEvent.change(field, { target: { value: 'Saved' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Closed');
  expect(writes).toEqual(['PATCH']);
});
