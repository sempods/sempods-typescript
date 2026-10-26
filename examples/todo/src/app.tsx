import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AppAccess,
  AccessNotice,
  LoadNotice,
  RemoveButton,
  ResourceEditor,
  UnresolvedNotices,
  UpdateNotice,
  SempodsProvider,
  useAppState,
  useContexts,
  useFieldUpdate,
  useCreation,
  useList,
  useSelection,
  TargetScreen,
  useResourceEditor,
  useMessages,
  useSdkLocale,
  type ContextList,
  type FieldUpdateRow,
} from '@sempods/app-sdk/react';
import type { BrowserRuntime } from '@sempods/app-sdk';
import { emptyTask, taskFields, type Task } from './domain.js';

/** The app's own texts; the SDK's controls bring theirs. */
const text = {
  en: {
    tasks: 'Tasks',
    task: 'Task',
    newTask: 'New task',
    add: 'Add',
    done: 'Done',
    empty: 'No tasks yet.',
    menu: 'Menu',
    language: 'Language',
    description: 'Tasks, stored in a Pod.',
    readOnly: 'read only',
    shareMore: 'Share more lists',
  },
  de: {
    tasks: 'Aufgaben',
    task: 'Aufgabe',
    newTask: 'Neue Aufgabe',
    add: 'Hinzufügen',
    done: 'Erledigt',
    empty: 'Noch keine Aufgaben.',
    menu: 'Menü',
    language: 'Sprache',
    description: 'Aufgaben, gespeichert in einem Pod.',
    readOnly: 'nur lesen',
    shareMore: 'Weitere Listen freigeben',
  },
};

function TaskScreen() {
  const m = useMessages(text);
  // The rows stay while the list reloads, also when the page becomes visible
  // again; LoadNotice says what the read does and offers a retry.
  const list = useList(taskFields);
  const tasks = list.data?.items;
  // One hook for the list; it keeps a write lane per task, so a tick locks
  // only its row, and an unresolved one survives the row being gone.
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
      {tasks?.length === 0 && <p className="empty">{m.empty}</p>}
      <ul className="tasks">
        {tasks?.map((item) => (
          <TaskRow
            key={item.iri}
            row={mutate.for(item)}
            editing={selected === item.iri ? editing : null}
            onOpen={() => void select(item.iri)}
          />
        ))}
      </ul>
      {/* An unresolved tick or delete whose task left the list keeps its recovery. */}
      <UnresolvedNotices of={mutate} shown={tasks} />
      {/* A row that left the list (deleted elsewhere) keeps its editor. */}
      {selected && !tasks?.some((item) => item.iri === selected) && editing}
      <UpdateNotice {...creation.notice} quiet />
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void creation.create();
        }}
      >
        <input
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

/**
 * One task: a checkbox to finish it, its title to edit it and, once done, a
 * delete button that asks first. Its write locks only this row, and a problem
 * with it shows right here. The changed or vanished row is the confirmation.
 */
function TaskRow({
  row,
  editing,
  onOpen,
}: {
  /** This task in the list's write lanes: what to show, its lock, notice and commands. */
  readonly row: FieldUpdateRow<Task>;
  /** The row's editor while it is open; the title opens it in its place. */
  readonly editing: ReactNode;
  readonly onOpen: () => void;
}) {
  const m = useMessages(text);
  const { remove } = useSdkLocale().messages.controls;
  const task = row.data;
  return (
    <li className={task.done ? 'done' : undefined}>
      <input
        type="checkbox"
        aria-label={`${m.done}: ${task.title}`}
        checked={task.done}
        disabled={!row.canMutate}
        onChange={() => void row.update({ done: !task.done })}
      />
      {editing ?? (
        <button className="title" onClick={onOpen}>
          {task.title}
        </button>
      )}
      {/* The open editor has its own Delete. */}
      {task.done && !editing && (
        <RemoveButton
          label={`${remove}: ${task.title}`}
          disabled={!row.canMutate}
          onRemove={row.remove}
        />
      )}
      <UpdateNotice {...row.notice} quiet />
    </li>
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
    <SempodsProvider runtime={runtime} locale={locale}>
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
  // Mounted before a list is chosen: it selects one, so no chooser appears.
  const lists = useContexts();
  const m = useMessages(text);
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
            <ListSwitch lists={lists} />
          </>
        )}
        {/* A native popover: the browser closes it on Escape or outside. */}
        <button
          ref={focusTarget}
          className="menu-button"
          popoverTarget="app-menu"
          aria-label={m.menu}
          title={m.menu}
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
            {m.language}
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
      {/* Preparing the Pod's consent can fail (unreachable Pod); say so here. */}
      {lists.shareProblem && <p role="alert">{lists.shareProblem}</p>}
      <AppAccess
        appName="TODO"
        icon={icon}
        description={m.description}
        mode="single"
        open={open}
        onClose={() => setOpen(false)}
        focusTarget={focusTarget}
      />
      <AccessNotice only="write" />
      <TargetScreen>
        <TaskScreen />
      </TargetScreen>
    </main>
  );
}

/**
 * The header's list switch: the chosen list's name, and with several lists a
 * menu to switch (under the leave policy) or to share more lists on the Pod.
 */
function ListSwitch({ lists }: { readonly lists: ContextList }) {
  const m = useMessages(text);
  const current = lists.selected;
  if (!current) return null;
  if (lists.contexts.length < 2) return <h1>{current.name}</h1>;
  return (
    <>
      <h1>
        <button className="list-button" popoverTarget="list-menu">
          {current.name}
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </h1>
      <div id="list-menu" className="menu list-menu" popover="auto">
        {lists.contexts.map((list) => (
          <button
            key={list.iri}
            popoverTarget="list-menu"
            popoverTargetAction="hide"
            aria-pressed={list.iri === current.iri}
            onClick={() => void lists.select(list.iri)}
          >
            <span className="check" aria-hidden="true">
              {list.iri === current.iri ? '✓' : ''}
            </span>
            {list.name}
            {!list.writable && <small>{m.readOnly}</small>}
          </button>
        ))}
        {lists.canShare && (
          <>
            <hr />
            <button
              popoverTarget="list-menu"
              popoverTargetAction="hide"
              onClick={() => void lists.share()}
            >
              {m.shareMore}
            </button>
          </>
        )}
      </div>
    </>
  );
}
