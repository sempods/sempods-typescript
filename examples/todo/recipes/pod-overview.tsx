import { useRef, useState } from 'react';
import type { BrowserRuntime } from '@sempods/app-sdk';
import { fields, text } from '@sempods/client-sdk/edit';
import {
  AppAccess,
  ResourceEditor,
  SempodsProvider,
  TargetScreen,
  UpdateNotice,
  useContextEditor,
  useCreation,
  usePodLoad,
  useSdkLocale,
  useWorkflowAccess,
  type ContextEditorRetirement,
  type ContextTarget,
} from '@sempods/app-sdk/react';

// This query does not enumerate Contexts. GRAPH requests source provenance;
// which graphs the caller may query remains the server's authorization contract.
const query = `SELECT ?item ?graph WHERE {
  GRAPH ?graph { ?item a <urn:Note> }
} LIMIT 100`;
const note = fields(
  { title: text('urn:note:title', { language: null }) },
  {
    type: 'urn:Note',
  },
);

/** Why editing a row ended without the person closing it. */
const retirement: Record<ContextEditorRetirement, string> = {
  declined: 'The note was not opened; your other changes are kept.',
  blocked: 'The note was not opened while another change was saving.',
  'context-changed': 'Editing ended because another Context was chosen.',
  'connection-changed': 'Editing ended because another Pod was chosen.',
};

function Overview({
  onEdit,
}: {
  readonly onEdit: (target: ContextTarget) => void;
}) {
  const { state, reload } = usePodLoad((pod, signal) =>
    pod.sparql.select(query, { signal }),
  );
  const { messages: m, error } = useSdkLocale();
  return (
    <section aria-label="Pod overview">
      <h1>Notes across my Pod</h1>
      {state.kind === 'ready' ? (
        <ul>
          {state.data.rows.map((row, index) => {
            const item = row.item?.type === 'iri' ? row.item.value : null;
            const graph = row.graph?.type === 'iri' ? row.graph.value : null;
            return (
              <li key={index}>
                {item ?? 'Unsupported item'}
                {' · '}
                {graph ?? 'Unknown source'}
                {item && graph && (
                  <>
                    {' '}
                    <button
                      aria-label={`Edit ${item}`}
                      onClick={() => onEdit({ subject: item, context: graph })}
                    >
                      Edit
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p role={state.kind === 'failed' ? 'alert' : 'status'}>
          {state.kind === 'failed'
            ? error(state.error)
            : state.kind === 'loading'
              ? m.controls.loading
              : m.controls.readLost}
        </p>
      )}
      <button onClick={() => void reload()} disabled={state.kind === 'loading'}>
        Reload overview
      </button>
    </section>
  );
}

function NewNote() {
  // All writes still belong to one explicitly validated Context, independently
  // of the read-only overview. Never edit a merged SELECT row as a snapshot.
  const creation = useCreation(note, {
    initial: { title: '' },
    collection: 'notes',
  });
  const access = useWorkflowAccess();
  const { messages: m } = useSdkLocale();
  return (
    <section aria-label="Context note">
      <UpdateNotice {...creation.notice} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void creation.create();
        }}
      >
        <label>
          New note
          <input
            value={creation.draft.title}
            disabled={!access.write || !creation.canEdit}
            onChange={(event) => creation.change({ title: event.target.value })}
          />
        </label>
        <button disabled={!access.write || !creation.canCreate}>
          {m.controls.save}
        </button>
      </form>
    </section>
  );
}

function Content() {
  const [manage, setManage] = useState(false);
  const [scoped, setScoped] = useState(false);
  // An overview row is only a pointer: the subject and the Context its GRAPH
  // binding names. The hook selects that Context, reads the note fresh there and
  // saves with its version (If-Match), never from the SELECT row. Opening another
  // row or closing runs under the leave policy.
  const edit = useContextEditor(note);
  const menu = useRef<HTMLButtonElement>(null);
  const { messages: m } = useSdkLocale();
  return (
    <main>
      <button
        ref={menu}
        aria-expanded={manage}
        onClick={() => setManage(!manage)}
      >
        {m.controls.dataAccess}
      </button>
      <AppAccess appName="Notes overview" open={manage} focusTarget={menu} />
      <Overview onEdit={(row) => void edit.open(row)} />
      <button onClick={() => setScoped(true)} disabled={scoped}>
        Create a note
      </button>
      {/* Mount the demand boundary before a view exists. AppAccess then offers
          discovery/selection/retry; labels never gate this flow. Keep mounted
          through access loss and while this form owns drafts or write outcomes. */}
      {scoped && (
        <TargetScreen>
          <NewNote />
        </TargetScreen>
      )}
      {edit.reason && (
        <p role="status">
          {retirement[edit.reason]}{' '}
          {/* A retired target closes at once, without asking. */}
          <button onClick={() => void edit.close()}>Dismiss</button>
        </p>
      )}
      {edit.target && edit.phase !== 'retired' && (
        <section aria-label="Edit note">
          {edit.phase === 'unavailable' ? (
            <p role="alert">
              This note's Context is not available for editing.
            </p>
          ) : (
            <ResourceEditor editor={edit.editor}>
              {(draft, change) => (
                <label>
                  Note title
                  <input
                    value={draft.title}
                    onChange={(event) => change({ title: event.target.value })}
                  />
                </label>
              )}
            </ResourceEditor>
          )}
          <button onClick={() => void edit.close()}>Close editor</button>
        </section>
      )}
    </main>
  );
}

/** The host creates/disposes the stable runtime and serves this on the callback too. */
export function PodOverviewExample({
  runtime,
}: {
  readonly runtime: BrowserRuntime;
}) {
  return (
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <Content />
    </SempodsProvider>
  );
}
