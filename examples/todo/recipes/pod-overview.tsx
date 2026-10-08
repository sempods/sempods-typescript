import { useEffect, useRef, useState } from 'react';
import type { BrowserRuntime } from '@sempods/app-sdk';
import { fields, text } from '@sempods/client-sdk/edit';
import {
  AppAccess,
  ResourceEditor,
  SempodsProvider,
  TargetScreen,
  UpdateNotice,
  useApp,
  useAppState,
  useCreation,
  usePodLoad,
  useResourceEditor,
  useSdkLocale,
  useView,
  useWorkflowAccess,
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

/** An overview row is only a pointer: the subject and the Context its GRAPH binding names. */
interface RowTarget {
  readonly item: string;
  readonly graph: string;
}

/** The row, plus the connection that was active when editing started. */
interface EditTarget extends RowTarget {
  readonly connection: string;
}

function Overview({
  onEdit,
}: {
  readonly onEdit: (target: RowTarget) => void;
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
                      onClick={() => onEdit({ item, graph })}
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

/**
 * Edits an overview row inside the Context its GRAPH binding names. TargetScreen demands
 * discovery; once the catalogue lists that Context as readable it is selected explicitly,
 * and the editor mounts only for a view of exactly that Context. The editor reads the
 * resource fresh there and saves with its version (If-Match), never from the SELECT row.
 */
function EditInContext({
  target,
  onClose,
}: {
  readonly target: EditTarget;
  readonly onClose: () => void;
}) {
  const app = useApp();
  const { connections, activeId, changing, confirmingLeave } = useAppState();
  const view = useView();
  const connection = connections.find((c) => c.id === activeId);
  const catalogue = connection?.catalogue;
  const readable =
    catalogue?.kind === 'ready' &&
    catalogue.contexts.some((c) => c.iri === target.graph && c.readable);
  const selected = connection?.selectedContext ?? null;
  const close = useRef(onClose);
  close.current = onClose;
  // One selection attempt per Context, also across StrictMode's repeated effects.
  const attempt = useRef<string | null>(null);
  // Set once this editor's Context was selected; a later change came from elsewhere.
  const activated = useRef(false);
  const retired = useRef(false);
  const current = activeId === target.connection;
  useEffect(() => {
    // The Edit click itself runs as a guarded navigation; act only once it settled.
    if (changing || confirmingLeave) return;
    const retire = () => {
      if (retired.current) return;
      retired.current = true;
      close.current();
    };
    // Another Pod connection became active: this row belongs to the old one.
    if (!current) return retire();
    if (selected === target.graph) {
      activated.current = true;
      return;
    }
    // The person chose another Context after this one (for example in AppAccess):
    // retire the editor rather than selecting its old Context again.
    if (activated.current) return retire();
    if (!readable || attempt.current === target.graph) return;
    const graph = target.graph;
    attempt.current = graph;
    // Guarded like any Context change: drafts elsewhere ask before leaving. When the
    // person keeps them, close this editor instead of leaving an empty shell open.
    void app.selectContext(graph).then((accepted) => {
      if (attempt.current !== graph) return;
      attempt.current = null;
      if (!accepted) close.current();
    });
  }, [
    app,
    current,
    readable,
    selected,
    target.graph,
    changing,
    confirmingLeave,
  ]);
  return (
    <section aria-label="Edit note">
      {current && catalogue?.kind === 'ready' && !readable && (
        <p role="alert">This note's Context is not available for editing.</p>
      )}
      {/* Only the originating connection may demand discovery for this row. */}
      {current && (
        <TargetScreen>
          {view?.contextIri === target.graph && (
            <NoteEditor key={target.item} item={target.item} />
          )}
        </TargetScreen>
      )}
      <button onClick={onClose}>Close editor</button>
    </section>
  );
}

function NoteEditor({ item }: { readonly item: string }) {
  const editor = useResourceEditor(item, note);
  return (
    <ResourceEditor editor={editor}>
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
  );
}

function Content() {
  const [manage, setManage] = useState(false);
  const [scoped, setScoped] = useState(false);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  // Changing or closing the edited row unmounts its editor: run it under the leave
  // policy, so an unsaved draft or a pending write asks before it is discarded.
  const app = useApp();
  const { activeId } = useAppState();
  const edit = (target: EditTarget | null) =>
    void app.navigate(() => setEditing(target));
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
      <Overview
        onEdit={(row) => {
          if (activeId) edit({ ...row, connection: activeId });
        }}
      />
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
      {editing && (
        <EditInContext
          key={`${editing.connection} ${editing.graph} ${editing.item}`}
          target={editing}
          onClose={() => edit(null)}
        />
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
