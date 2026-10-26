import { useMemo, useRef, useState, type ReactNode } from 'react';
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
  };
  // The rows stay while the list reloads, also when the page becomes visible
  // again; LoadNotice says what the read does and offers a retry.
  const list = useList(taskFields);
  const tasks = list.data?.items;
  const mutate = useFieldUpdate(taskFields);
  const creation = useCreation(taskFields, {
    initial: emptyTask,
    collection: 'tasks',
  });
  const { selected, select } = useSelection();
  const editor = useResourceEditor(selected, taskFields);
  // Enter saves, Escape or Cancel closes; a saved or deleted row closes it.
  const editing = (
    <ResourceEditor editor={editor} onClose={() => select(null)}>
      {(draft, change) => (
        <input
          aria-label={m.task}
          autoFocus
          value={draft.title}
          onChange={(e) => change({ title: e.target.value })}
        />
      )}
    </ResourceEditor>
  );

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
            {/* The title opens the row's editor in its place. */}
            {selected === item.iri ? (
              editing
            ) : (
              <button className="title" onClick={() => void select(item.iri)}>
                {item.data.title}
              </button>
            )}
          </li>
        ))}
      </ul>
      {/* A row that left the list (deleted elsewhere) keeps its editor. */}
      {selected && !tasks?.some((item) => item.iri === selected) && editing}
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
        <button
          className="add"
          aria-label={m.add}
          title={m.add}
          disabled={!creation.canCreate}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </form>
    </section>
  );
}

/** The menu's languages; the provider follows the browser's until one is picked. */
const languages = ['de', 'en'] as const;

/** The app's icon: in the header and on the sign-in screen. */
const icon = (
  <svg className="app-icon" viewBox="0 0 32 32" aria-hidden="true">
    <rect x="3" y="3" width="26" height="26" rx="7" />
    <path d="m10 16.5 4 4 8-9" />
  </svg>
);

/**
 * The TODO app with the SDK's standard UI: `AppAccess` beside the app's own
 * header and screen. Until a language is picked in the menu, the provider
 * follows the browser's language.
 */
export function TodoApp({
  runtime,
  children,
}: {
  readonly runtime: BrowserRuntime;
  /** App-level notices share the selected language and remain outside target gates. */
  readonly children?: ReactNode;
}) {
  // A picked locale sets messages and formatting together.
  const [locale, setLocale] = useState<'en' | 'de'>();

  return (
    <SempodsProvider runtime={runtime} {...(locale ? { locale } : {})}>
      {children}
      <StandardScreen onLocale={setLocale} />
    </SempodsProvider>
  );
}

function StandardScreen({
  onLocale,
}: {
  readonly onLocale: (locale: 'en' | 'de') => void;
}) {
  const [open, setOpen] = useState(false);
  const focusTarget = useRef<HTMLButtonElement>(null);
  const { messages, language } = useSdkLocale();
  const { view, connections } = useAppState();
  const access = useWorkflowAccess();
  const de = language === 'de';
  // Language names in the current language: Deutsch/Englisch, German/English.
  const names = useMemo(
    () => new Intl.DisplayNames([language], { type: 'language' }),
    [language],
  );

  return (
    <main className="standard">
      <header className="app-heading">
        {view && (
          <>
            {icon}
            <h1>TODO</h1>
          </>
        )}
        {/* A native popover: the browser closes it on Escape or outside. */}
        <button
          ref={focusTarget}
          className="menu-button"
          popoverTarget="app-menu"
          aria-label={de ? 'Menü' : 'Menu'}
          title={de ? 'Menü' : 'Menu'}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="5" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="12" cy="19" r="1.8" />
          </svg>
        </button>
        <div id="app-menu" className="menu" popover="auto">
          {connections.length > 0 && (
            <button
              popoverTarget="app-menu"
              popoverTargetAction="hide"
              aria-haspopup="dialog"
              onClick={() => setOpen(true)}
            >
              {messages.controls.dataAccess}
            </button>
          )}
          <p id="menu-language" className="menu-label">
            {de ? 'Sprache' : 'Language'}
          </p>
          <div role="group" aria-labelledby="menu-language">
            {languages.map((code) => (
              <button
                key={code}
                popoverTarget="app-menu"
                popoverTargetAction="hide"
                aria-pressed={language === code}
                onClick={() => onLocale(code)}
              >
                <span className="check" aria-hidden="true">
                  {language === code ? '✓' : ''}
                </span>
                {names.of(code)}
              </button>
            ))}
          </div>
        </div>
      </header>
      <AppAccess
        appName="TODO"
        icon={icon}
        description={
          de ? 'Aufgaben, gespeichert in einem Pod.' : 'Tasks, stored in a Pod.'
        }
        mode="single"
        open={open}
        onClose={() => setOpen(false)}
        focusTarget={focusTarget}
      />
      {view && access.read && !access.write && <AccessNotice />}
      <TargetScreen>
        <TaskScreen />
      </TargetScreen>
    </main>
  );
}
