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
  type ContextTarget,
} from '@sempods/app-sdk/react';
import { ActionButton, Button, Input } from '@sempods/app-ui';

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
                    <Button
                      variant="ghost"
                      className="min-h-11 px-3"
                      aria-label={`Edit ${item}`}
                      onPress={() => onEdit({ subject: item, context: graph })}
                    >
                      Edit
                    </Button>
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
              : state.kind === 'cancelled'
                ? 'Loading the overview was cancelled.'
                : 'The overview cannot be read right now.'}
        </p>
      )}
      <Button
        variant="secondary"
        className="min-h-11 px-4"
        onPress={() => void reload()}
        isDisabled={state.kind === 'loading'}
      >
        Reload overview
      </Button>
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
        <label className="grid gap-1.5">
          New note
          <Input
            className="h-11"
            value={creation.draft.title}
            disabled={!access.write || !creation.canEdit}
            onChange={(event) => creation.change({ title: event.target.value })}
          />
        </label>
        <ActionButton
          type="submit"
          isDisabled={!access.write || !creation.canCreate}
        >
          {m.controls.save}
        </ActionButton>
      </form>
    </section>
  );
}

function Content() {
  const [manage, setManage] = useState(false);
  const [scoped, setScoped] = useState(false);
  // An overview row is only a pointer: the subject and the Context its GRAPH
  // binding names. The hook binds that Context explicitly, reads the note fresh
  // there and saves with its version (If-Match), never from the SELECT row. The
  // selected Context, and with it the creation form below, stays as it is.
  // Opening another row or closing runs under the leave policy.
  const edit = useContextEditor(note);
  const menu = useRef<HTMLButtonElement>(null);
  const { messages: m } = useSdkLocale();
  return (
    <main>
      <Button
        ref={menu}
        variant="ghost"
        className="min-h-11 px-3"
        aria-expanded={manage}
        onPress={() => setManage(!manage)}
      >
        {m.controls.dataAccess}
      </Button>
      <AppAccess appName="Notes overview" open={manage} focusTarget={menu} />
      <Overview onEdit={(row) => void edit.open(row)} />
      <ActionButton
        variant="secondary"
        onPress={() => setScoped(true)}
        isDisabled={scoped}
      >
        Create a note
      </ActionButton>
      {/* Mount the demand boundary before a view exists. AppAccess then offers
          discovery/selection/retry; labels never gate this flow. Keep mounted
          through access loss and while this form owns drafts or write outcomes. */}
      {scoped && (
        <TargetScreen>
          <NewNote />
        </TargetScreen>
      )}
      {edit.phase === 'retired' && (
        <p role="status">
          Editing ended because another Pod was chosen.{' '}
          {/* A retired target closes at once, without asking. */}
          <Button
            variant="ghost"
            className="min-h-11 px-3"
            onPress={() => void edit.close()}
          >
            Dismiss
          </Button>
        </p>
      )}
      {edit.target && edit.phase !== 'retired' && (
        <section aria-label="Edit note">
          {edit.problem ? (
            <p role="alert">{m.contextProblems![edit.problem]}</p>
          ) : (
            <ResourceEditor editor={edit.editor}>
              {(draft, change) => (
                <label className="grid gap-1.5">
                  Note title
                  <Input
                    className="h-11"
                    value={draft.title}
                    onChange={(event) => change({ title: event.target.value })}
                  />
                </label>
              )}
            </ResourceEditor>
          )}
          <Button
            variant="secondary"
            className="min-h-11 px-4"
            onPress={() => void edit.close()}
          >
            Close editor
          </Button>
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
