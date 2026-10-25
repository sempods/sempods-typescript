import { useRef, useState, type ReactNode } from 'react';
import {
  AppShell,
  AppAccess,
  ConnectionControls,
  AccessNotice,
  ResourceEditor,
  UpdateNotice,
  CallbackNotice,
  SempodsProvider,
  useAppState,
  useFieldUpdate,
  useCreation,
  useList,
  useSelection,
  TargetScreen,
  useResourceEditor,
  useSdkLocale,
  useWorkflowAccess,
} from '@sempods/app-sdk/react';
import type { BrowserRuntime } from '@sempods/app-sdk';
import { emptyTask, supportedTasks, taskFields } from './domain.js';

function TaskScreen() {
  const { language, messages, error } = useSdkLocale();
  const de = language === 'de';
  // retain: the rows stay while the list reloads, also after a confirmed write.
  const list = useList(taskFields, { retain: true });
  const shown =
    list.state.kind === 'ready'
      ? list.state.data
      : 'previous' in list.state
        ? list.state.previous
        : undefined;
  const tasks = shown ? supportedTasks(shown) : null;
  const mutate = useFieldUpdate(taskFields);
  const creation = useCreation(taskFields, {
    initial: emptyTask,
    collection: 'tasks',
  });
  const { selected, select } = useSelection();
  const editor = useResourceEditor(selected, taskFields);
  const m = {
    title: de ? 'Aufgabe' : 'Task',
    add: de ? 'Hinzufügen' : 'Add',
    done: de ? 'Erledigt' : 'Done',
    tasks: de ? 'Aufgaben' : 'Tasks',
    empty: de ? 'Noch keine Aufgaben.' : 'No tasks yet.',
    complete: de ? 'Erledigen' : 'Complete',
    reopen: de ? 'Wieder öffnen' : 'Reopen',
    skipped: de ? 'Nicht unterstützte Einträge' : 'Unsupported entries',
    reload: de ? 'Neu laden' : 'Reload',
    cancelled: de ? 'Das Laden wurde abgebrochen.' : 'Loading was cancelled.',
    unavailable: de
      ? 'Die Aufgaben können gerade nicht gelesen werden.'
      : 'The tasks cannot be read right now.',
    stale: de
      ? 'Die Liste unten ist vielleicht nicht aktuell.'
      : 'The list below may be out of date.',
  };

  return (
    <section aria-label={m.tasks}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          creation.change({ title: creation.draft.title.trim() });
          void creation.create();
        }}
      >
        <label>
          {m.title}
          <input
            required
            disabled={!creation.canEdit}
            value={creation.draft.title}
            onChange={(e) => creation.change({ title: e.target.value })}
          />
        </label>{' '}
        <button disabled={!creation.canCreate}>{m.add}</button>
      </form>
      {/* The new or changed row is the confirmation; problems still show. */}
      <UpdateNotice {...creation.notice} quiet />
      <UpdateNotice {...mutate.notice} quiet />
      {/* Each read state says what happened; none promises a draft. */}
      {list.state.kind === 'loading' && !tasks && (
        <p role="status">{messages.controls.loading}</p>
      )}
      {list.state.kind === 'failed' && (
        <p role="alert">
          {error(list.state.error)}
          {tasks ? ` ${m.stale}` : ''}
        </p>
      )}
      {list.state.kind === 'cancelled' && <p role="status">{m.cancelled}</p>}
      {list.state.kind === 'unavailable' && (
        <p role="status">{m.unavailable}</p>
      )}
      <button onClick={() => void list.reload()}>{m.reload}</button>
      {tasks && (
        <>
          {tasks.skipped > 0 && (
            <p>
              {m.skipped}: {tasks.skipped}
            </p>
          )}
          {tasks.items.length === 0 && <p>{m.empty}</p>}
          <ul>
            {tasks.items.map((item) => (
              <li
                key={item.iri}
                style={{
                  display: 'flex',
                  gap: 12,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  padding: '10px 0',
                }}
              >
                <button onClick={() => void select(item.iri)}>
                  {item.data.title}
                </button>
                <span>{item.data.done ? '✓' : ''}</span>
                <button
                  disabled={!mutate.canMutate}
                  onClick={() =>
                    void mutate.update(item, { done: !item.data.done })
                  }
                >
                  {item.data.done ? m.reopen : m.complete}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {selected && (
        <ResourceEditor editor={editor}>
          {(draft, change) => (
            <div style={{ display: 'grid', gap: 12 }}>
              <label>
                {m.title}
                <input
                  value={draft.title}
                  onChange={(e) => change({ title: e.target.value })}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={draft.done}
                  onChange={(e) => change({ done: e.target.checked })}
                />
                {m.done}
              </label>
            </div>
          )}
        </ResourceEditor>
      )}
    </section>
  );
}

function CustomScreen() {
  const state = useAppState();
  const { messages, error } = useSdkLocale();
  const m = messages.controls;

  return (
    <main className="custom">
      <h1>TODO · Custom</h1>
      {state.startupError ? (
        <p role="alert">{error(state.startupError)}</p>
      ) : !state.startup ? (
        <p>{m.loading}</p>
      ) : state.startup.storage === 'busy' ? (
        <p role="alert">{m.busy}</p>
      ) : state.startup.storage === 'unavailable' ? (
        <p role="alert">{m.storage}</p>
      ) : (
        <>
          <CallbackNotice />
          <aside>
            <ConnectionControls />
          </aside>
          <AccessNotice />
          <TargetScreen>
            <TaskScreen />
          </TargetScreen>
        </>
      )}
    </main>
  );
}

export function TodoApp({
  runtime,
  custom,
  children,
  legacy = false,
}: {
  readonly runtime: BrowserRuntime;
  readonly custom?: boolean;
  /** App-level notices share the selected language and remain outside target gates. */
  readonly children?: ReactNode;
  /** Legacy AppShell remains available for existing applications. */
  readonly legacy?: boolean;
}) {
  // Until the person picks one, the provider follows the browser's language.
  // A picked locale sets messages and formatting together.
  const [locale, setLocale] = useState<'en' | 'de'>();

  return (
    <SempodsProvider runtime={runtime} {...(locale ? { locale } : {})}>
      <nav aria-label="Language">
        <button onClick={() => setLocale('en')}>English</button>
        <button onClick={() => setLocale('de')}>Deutsch</button>
      </nav>
      {children}
      <TodoLayout custom={custom} legacy={legacy} />
    </SempodsProvider>
  );
}

function TodoLayout({
  custom,
  legacy,
}: {
  readonly custom: boolean | undefined;
  readonly legacy: boolean;
}) {
  useAppState(); // Also redraw after the initializer restores the callback's return route.
  return (custom ?? location.pathname === '/custom') ? (
    <CustomScreen />
  ) : legacy || location.pathname === '/legacy' ? (
    <AppShell title="TODO" style={{ color: 'light-dark(#173740, #e8eee9)' }}>
      <TargetScreen>
        <TaskScreen />
      </TargetScreen>
    </AppShell>
  ) : (
    <StandardScreen />
  );
}

function StandardScreen() {
  const [open, setOpen] = useState(false);
  const focusTarget = useRef<HTMLButtonElement>(null);
  const { messages, language } = useSdkLocale();
  const { view, connections } = useAppState();
  const access = useWorkflowAccess();

  return (
    <main className="standard">
      {connections.length > 0 && (
        <header className="app-heading">
          {view && <h1>TODO</h1>}
          <button
            ref={focusTarget}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {messages.controls.dataAccess}
          </button>
        </header>
      )}
      <AppAccess
        appName="TODO"
        description={
          language === 'de'
            ? 'Aufgaben, gespeichert in einem Pod.'
            : 'Tasks, stored in a Pod.'
        }
        open={open}
        focusTarget={focusTarget}
      />
      {view && access.read && !access.write && <AccessNotice />}
      <TargetScreen>
        <TaskScreen />
      </TargetScreen>
    </main>
  );
}
