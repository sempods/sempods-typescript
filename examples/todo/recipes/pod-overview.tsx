import { useRef, useState } from 'react';
import type { BrowserRuntime } from '@sempods/app-sdk';
import { fields, text } from '@sempods/client-sdk/edit';
import {
  AppAccess,
  SempodsProvider,
  TargetScreen,
  UpdateNotice,
  useCreation,
  usePodLoad,
  useSdkLocale,
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
function Overview() {
  const { state, reload } = usePodLoad((pod, signal) =>
    pod.sparql.select(query, { signal }),
  );
  const { messages: m, error } = useSdkLocale();
  return (
    <section aria-label="Pod overview">
      <h1>Notes across my Pod</h1>
      {state.kind === 'ready' ? (
        <ul>
          {state.data.rows.map((row, index) => (
            <li key={index}>
              {row.item?.type === 'iri' ? row.item.value : 'Unsupported item'}
              {' · '}
              {row.graph?.type === 'iri' ? row.graph.value : 'Unknown source'}
            </li>
          ))}
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
      <Overview />
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
