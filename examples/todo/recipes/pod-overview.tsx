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
interface EditTarget {
  readonly item: string;
  readonly graph: string;
}
function Overview({
  onEdit,
}: {
  readonly onEdit: (target: EditTarget) => void;
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
  const { connections, activeId } = useAppState();
  const view = useView();
  const connection = connections.find((c) => c.id === activeId);
  const catalogue = connection?.catalogue;
  const readable =
    catalogue?.kind === 'ready' &&
    catalogue.contexts.some((c) => c.iri === target.graph && c.readable);
  const selected = connection?.selectedContext ?? null;
  useEffect(() => {
    // Guarded like any Context change: open drafts elsewhere ask before leaving.
    if (readable && selected !== target.graph)
      void app.selectContext(target.graph);
  }, [app, readable, selected, target.graph]);
  return (
    <section aria-label="Edit note">
      {catalogue?.kind === 'ready' && !readable && (
        <p role="alert">This note's Context is not available for editing.</p>
      )}
      <TargetScreen>
        {view?.contextIri === target.graph && (
          <NoteEditor key={target.item} item={target.item} />
        )}
      </TargetScreen>
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
      <Overview onEdit={setEditing} />
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
        <EditInContext target={editing} onClose={() => setEditing(null)} />
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
