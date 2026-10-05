import { useState, type ReactNode } from 'react';
import {
  AppShell,
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
} from '@sempods/app-sdk/react';
import type { BrowserRuntime } from '@sempods/app-sdk';
import { emptyTask, supportedTasks, taskFields } from './domain.js';

function TaskScreen() {
  const { language, messages } = useSdkLocale();
  const de = language === 'de';
  const list = useList(taskFields);
  const tasks =
    list.state.kind === 'ready' ? supportedTasks(list.state.data) : null;
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
      <UpdateNotice {...creation.notice} />
      <UpdateNotice {...mutate.notice} />
      {list.state.kind === 'loading' && (
        <p role="status">{messages.controls.loading}</p>
      )}
      {list.state.kind !== 'ready' && list.state.kind !== 'loading' && (
        <p role="status">{messages.controls.readLost}</p>
      )}
      <button onClick={() => void list.reload()}>
        {messages.controls.refresh}
      </button>
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
}: {
  readonly runtime: BrowserRuntime;
  readonly custom?: boolean;
  /** App-level notices share the selected language and remain outside target gates. */
  readonly children?: ReactNode;
}) {
  const [language, setLanguage] = useState<'en' | 'de'>('en');
  return (
    <SempodsProvider runtime={runtime} language={language}>
      <nav aria-label="Language">
        <button onClick={() => setLanguage('en')}>English</button>
        <button onClick={() => setLanguage('de')}>Deutsch</button>
      </nav>
      {children}
      <TodoLayout custom={custom} />
    </SempodsProvider>
  );
}

function TodoLayout({ custom }: { readonly custom: boolean | undefined }) {
  useAppState(); // Also redraw after the initializer restores the callback's return route.
  return (custom ?? location.pathname === '/custom') ? (
    <CustomScreen />
  ) : (
    <AppShell title="TODO">
      <TargetScreen>
        <TaskScreen />
      </TargetScreen>
    </AppShell>
  );
}
