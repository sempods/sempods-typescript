import { useEffect, useRef, useState } from 'react';
import type { BrowserRuntime } from '@sempods/app-sdk';
import { fields, flag, text } from '@sempods/client-sdk/edit';
import {
  AppAccess,
  ResourceEditor,
  SempodsProvider,
  useApp,
  useAppState,
  useContextEditor,
  usePodLoad,
  useSdkLocale,
  type ContextEditorProblem,
  type ContextTarget,
} from '@sempods/app-sdk/react';

const schema = 'https://schema.org/';
// GRAPH names each row's Context; OPTIONAL keeps rows without a status.
const query = `SELECT ?item ?graph ?title ?status WHERE {
  GRAPH ?graph {
    ?item a <${schema}Action> .
    OPTIONAL { ?item <${schema}name> ?title }
    OPTIONAL { ?item <${schema}actionStatus> ?status }
  }
} LIMIT 100`;
const task = fields(
  {
    title: text(schema + 'name', { language: null }),
    done: flag(schema + 'actionStatus', {
      on: schema + 'CompletedActionStatus',
      off: schema + 'PotentialActionStatus',
    }),
  },
  { type: schema + 'Action' },
);

/** Why a row cannot be changed here. */
const unavailable: Record<ContextEditorProblem, string> = {
  unreadable: "This task's Context is not available for changes.",
  'discovery-failed': 'Access to Contexts could not be checked; try again.',
  refused: 'This app does not change tasks in that Context.',
};

/**
 * One click ticks a task on an overview row, in the row's own Context. The
 * SELECT row is only a pointer: `useContextEditor` binds that Context, reads
 * the task fresh there, and the change is saved once against the version it
 * read (If-Match). The selection and any draft elsewhere stay as they are.
 *
 * Nothing is shown as changed before the Pod confirms it, and nothing is
 * resent. A refusal, a conflict or a lost answer keeps the editor open with
 * its own recovery controls; closing it runs under the leave policy.
 */
function useDoneToggle(onSaved: () => void) {
  const edit = useContextEditor(task);
  const [intent, setIntent] = useState<{
    readonly target: ContextTarget;
    readonly done: boolean;
  } | null>(null);
  // The change needs a decision: show the editor instead of a quiet tick.
  const [stuck, setStuck] = useState(false);
  const started = useRef<object | null>(null);
  const latest = useRef(edit);
  latest.current = edit;
  const editor = edit.editor;
  const target = edit.target;
  useEffect(() => {
    if (!intent || !editor || started.current === intent) return;
    if (
      target?.subject !== intent.target.subject ||
      target.context !== intent.target.context
    )
      return;
    started.current = intent;
    void (async () => {
      const loaded = await editor.loaded;
      if (loaded.phase !== 'ready') {
        setStuck(true); // Not found, offline or blocked: the editor says which.
        return;
      }
      editor.change({ done: intent.done });
      // Already as wanted: nothing to write.
      const outcome = editor.state.dirty ? await editor.save() : null;
      if (outcome && outcome.kind !== 'saved') {
        setStuck(true);
        return;
      }
      if (await latest.current.close()) {
        setIntent(null);
        onSaved();
      }
    })();
  }, [intent, editor, target, onSaved]);
  return {
    edit,
    pending: intent && !stuck ? intent.target : null,
    stuck: Boolean(intent) && (stuck || edit.problem !== null),
    async toggle(row: ContextTarget, done: boolean) {
      if (intent) return;
      setStuck(false);
      setIntent({ target: row, done });
      if (!(await edit.open(row))) setIntent(null);
    },
    async dismiss() {
      if (await edit.close()) {
        setIntent(null);
        setStuck(false);
      }
    },
  };
}

function Overview() {
  // retain: the rows stay visible while the overview reloads after a change.
  const { state, reload } = usePodLoad(
    (pod, signal) => pod.sparql.select(query, { signal }),
    { retain: true },
  );
  const { connections, activeId } = useAppState();
  const app = useApp();
  const { messages: m, error } = useSdkLocale();
  const toggle = useDoneToggle(() => void reload());
  const connection = connections.find((c) => c.id === activeId);
  const catalogue = connection?.catalogue;
  // On demand, nothing loads the catalogue for an overview; the boxes need its
  // rights, so ask for it once the session is active.
  const discover =
    connection?.session.kind === 'active' && catalogue?.kind === 'unknown'
      ? connection.id
      : null;
  useEffect(() => {
    if (discover) app.refreshContexts(discover).catch(() => {});
  }, [app, discover]);
  // Catalogue rights only disable the box; the Pod still decides on save.
  const writable = (context: string) =>
    catalogue?.kind === 'ready' &&
    catalogue.contexts.some((c) => c.iri === context && c.writable);
  const rows =
    state.kind === 'ready'
      ? state.data.rows
      : 'previous' in state && state.previous
        ? state.previous.rows
        : null;
  return (
    <section aria-label="Tasks across my Pod">
      <h1>Tasks across my Pod</h1>
      {state.kind === 'failed' && (
        <p role="alert">
          {error(state.error)}
          {state.previous ? ' The list below may be out of date.' : ''}
        </p>
      )}
      {rows ? (
        <ul>
          {rows.map((row, index) => {
            const item = row.item?.type === 'iri' ? row.item.value : null;
            const graph = row.graph?.type === 'iri' ? row.graph.value : null;
            const title =
              row.title?.type === 'literal' ? row.title.value : item;
            const done =
              row.status?.type === 'iri' &&
              row.status.value === schema + 'CompletedActionStatus';
            const saving =
              toggle.pending?.subject === item &&
              toggle.pending?.context === graph;
            return (
              <li key={index}>
                <label>
                  <input
                    type="checkbox"
                    checked={done}
                    disabled={
                      !item ||
                      !graph ||
                      !writable(graph) ||
                      toggle.pending !== null ||
                      toggle.stuck
                    }
                    onChange={(event) =>
                      item &&
                      graph &&
                      void toggle.toggle(
                        { subject: item, context: graph },
                        event.target.checked,
                      )
                    }
                  />
                  {title ?? 'Unsupported task'}
                </label>
                {saving && <span role="status"> Saving…</span>}
              </li>
            );
          })}
        </ul>
      ) : (
        state.kind !== 'failed' && (
          <p role="status">
            {state.kind === 'loading'
              ? m.controls.loading
              : state.kind === 'cancelled'
                ? 'Loading the tasks was cancelled.'
                : 'The tasks cannot be read right now.'}
          </p>
        )
      )}
      <button onClick={() => void reload()} disabled={state.kind === 'loading'}>
        Reload tasks
      </button>
      {toggle.stuck && toggle.edit.target && (
        <section aria-label="Finish the change">
          {toggle.edit.problem ? (
            <p role="alert">{unavailable[toggle.edit.problem]}</p>
          ) : (
            <ResourceEditor editor={toggle.edit.editor} quiet>
              {(draft, change) => (
                <label>
                  <input
                    type="checkbox"
                    checked={draft.done}
                    onChange={(event) => change({ done: event.target.checked })}
                  />
                  {draft.title}
                </label>
              )}
            </ResourceEditor>
          )}
          <button onClick={() => void toggle.dismiss()}>Close</button>
        </section>
      )}
    </section>
  );
}

/** The host creates/disposes the stable runtime and serves this on the callback too. */
export function OverviewToggleExample({
  runtime,
}: {
  readonly runtime: BrowserRuntime;
}) {
  const [manage, setManage] = useState(false);
  return (
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <OverviewToggleContent manage={manage} onManage={setManage} />
    </SempodsProvider>
  );
}

function OverviewToggleContent({
  manage,
  onManage,
}: {
  readonly manage: boolean;
  readonly onManage: (open: boolean) => void;
}) {
  const { messages: m } = useSdkLocale();
  return (
    <main>
      <button aria-expanded={manage} onClick={() => onManage(!manage)}>
        {m.controls.dataAccess}
      </button>
      <AppAccess appName="Tasks overview" open={manage} />
      <Overview />
    </main>
  );
}
