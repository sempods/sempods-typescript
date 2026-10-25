import { useRef, useState, type ReactNode } from 'react';
import {
  AppAccess,
  AccessNotice,
  LoadNotice,
  ResourceEditor,
  UpdateNotice,
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
import { emptyTask, taskFields } from './domain.js';

function TaskScreen() {
  const de = useSdkLocale().language === 'de';
  const m = {
    tasks: de ? 'Aufgaben' : 'Tasks',
    task: de ? 'Aufgabe' : 'Task',
    newTask: de ? 'Neue Aufgabe' : 'New task',
    add: de ? 'Hinzufügen' : 'Add',
    done: de ? 'Erledigt' : 'Done',
    empty: de ? 'Noch keine Aufgaben.' : 'No tasks yet.',
    reload: de ? 'Neu laden' : 'Reload',
  };
  // The rows stay while the list reloads; LoadNotice says what the read does.
  const list = useList(taskFields);
  const tasks = list.data?.items;
  const mutate = useFieldUpdate(taskFields);
  const creation = useCreation(taskFields, {
    initial: emptyTask,
    collection: 'tasks',
  });
  const { selected, select } = useSelection();
  const editor = useResourceEditor(selected, taskFields);

  return (
    <section aria-label={m.tasks}>
      <LoadNotice {...list} />
      {/* The new or changed row is the confirmation; problems still show. */}
      <UpdateNotice {...mutate.notice} quiet />
      {tasks?.length === 0 && <p className="empty">{m.empty}</p>}
      <ul className="tasks">
        {tasks?.map((item) => (
          <li key={item.iri} className={item.data.done ? 'done' : undefined}>
            <input
              type="checkbox"
              aria-label={`${m.done}: ${item.data.title}`}
              checked={item.data.done}
              disabled={!mutate.canMutate}
              onChange={() =>
                void mutate.update(item, { done: !item.data.done })
              }
            />
            <button
              aria-expanded={selected === item.iri}
              onClick={() => void select(item.iri)}
            >
              {item.data.title}
            </button>
          </li>
        ))}
      </ul>
      {selected && (
        <ResourceEditor editor={editor} onClose={() => select(null)}>
          {(draft, change) => (
            <>
              <label>
                {m.task}
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
            </>
          )}
        </ResourceEditor>
      )}
      <UpdateNotice {...creation.notice} quiet />
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          creation.change({ title: creation.draft.title.trim() });
          void creation.create();
        }}
      >
        <input
          required
          aria-label={m.newTask}
          placeholder={m.newTask}
          disabled={!creation.canEdit}
          value={creation.draft.title}
          onChange={(e) => creation.change({ title: e.target.value })}
        />
        <button className="primary" disabled={!creation.canCreate}>
          {m.add}
        </button>
      </form>
      <button className="reload" onClick={() => void list.reload()}>
        {m.reload}
      </button>
    </section>
  );
}

/**
 * The TODO app with the SDK's standard UI: `AppAccess` beside the app's own
 * header and screen. The EN/DE switch is the only addition; until it is used,
 * the provider follows the browser's language.
 */
export function TodoApp({
  runtime,
  children,
}: {
  readonly runtime: BrowserRuntime;
  /** App-level notices share the selected language and remain outside target gates. */
  readonly children?: ReactNode;
}) {
  // Until the person picks one, the provider follows the browser's language.
  // A picked locale sets messages and formatting together.
  const [locale, setLocale] = useState<'en' | 'de'>();

  return (
    <SempodsProvider runtime={runtime} {...(locale ? { locale } : {})}>
      <nav aria-label="Language">
        <button aria-label="English" onClick={() => setLocale('en')}>
          EN
        </button>
        <button aria-label="Deutsch" onClick={() => setLocale('de')}>
          DE
        </button>
      </nav>
      {children}
      <StandardScreen />
    </SempodsProvider>
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
