import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AccessNotice,
  AppAccess,
  LoadNotice,
  RemoveButton,
  ResourceEditor,
  UnresolvedNotices,
  UpdateNotice,
  SempodsProvider,
  useAppState,
  useFieldUpdate,
  useCreation,
  useList,
  useSelection,
  TargetScreen,
  useResourceEditor,
  useMessages,
  useSdkLocale,
  type FieldUpdateRow,
} from '@sempods/app-sdk/react';
import type { BrowserRuntime } from '@sempods/app-sdk';
import {
  ActionButton,
  ContextSwitch,
  HeaderMenu,
  I18nProvider,
  Input,
} from '@sempods/app-ui';
import { PlusIcon, UsersIcon } from 'lucide-react';
import { emptyTask, taskFields, type Task } from './domain.js';

/** The app's own texts; the SDK's controls and the UI kit bring theirs. */
const text = {
  en: {
    tasks: 'Tasks',
    task: 'Task',
    newTask: 'New task',
    add: 'Add',
    done: 'Done',
    empty: 'No tasks yet.',
    menu: 'Menu',
    settings: 'Settings',
    language: 'Language',
    description: 'Tasks, stored in a Pod.',
    list: 'List',
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
    settings: 'Einstellungen',
    language: 'Sprache',
    description: 'Aufgaben, gespeichert in einem Pod.',
    list: 'Liste',
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
        <Input
          aria-label={m.task}
          autoFocus
          className="h-11"
          value={draft.title}
          onChange={(e) => change({ title: e.target.value })}
        />
      )}
    </ResourceEditor>
  );

  return (
    <section aria-label={m.tasks}>
      <LoadNotice {...list} />
      {/* Empty only when confirmed: not on a failure, nor with skipped entries. */}
      {(list.state.kind === 'ready' || list.state.kind === 'loading') &&
        tasks?.length === 0 &&
        list.data?.skipped === 0 && (
          <p className="py-6 text-center text-muted-foreground">{m.empty}</p>
        )}
      <ul className="my-4">
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
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void creation.create();
        }}
      >
        <Input
          aria-label={m.newTask}
          placeholder={m.newTask}
          className="h-11 flex-1"
          disabled={!creation.canEdit}
          value={creation.draft.title}
          onChange={(e) => creation.change({ title: e.target.value })}
        />
        <ActionButton
          type="submit"
          shape="round-sm"
          label={m.add}
          isDisabled={!creation.canCreate}
        >
          <PlusIcon />
        </ActionButton>
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
    <li className="flex flex-wrap items-start gap-1 border-b *:data-[sempods-ui=editor]:min-w-0 *:data-[sempods-ui=editor]:flex-1 *:data-[sempods-ui=notice]:mb-2 *:data-[sempods-ui=notice]:ms-11 *:data-[sempods-ui=notice]:basis-full">
      {/* The wrapping label is the checkbox's 44px touch target; inside the
          editor's card it stays level with the field. */}
      <label
        className={
          'grid size-11 flex-none cursor-pointer place-items-center' +
          (editing ? ' mt-3' : '')
        }
      >
        <input
          type="checkbox"
          className="size-5.5 cursor-pointer accent-primary disabled:cursor-default disabled:opacity-55"
          aria-label={`${m.done}: ${task.title}`}
          checked={task.done}
          disabled={!row.canMutate}
          onChange={() => void row.update({ done: !task.done })}
        />
      </label>
      {editing ?? (
        <button
          className={
            'min-h-11 flex-1 cursor-pointer rounded-lg px-1 py-2.5 text-start wrap-anywhere hover:bg-muted' +
            (task.done ? ' text-muted-foreground line-through' : '')
          }
          onClick={onOpen}
        >
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

/**
 * The languages, each named in itself, so it is found whichever language
 * the app currently shows.
 */
const languages = [
  { code: 'de', name: 'Deutsch' },
  { code: 'en', name: 'English' },
] as const;
type Language = (typeof languages)[number]['code'];

/** The app's icon: in the header, on the startup and sign-in screens. */
const icon = (
  <svg
    viewBox="0 0 32 32"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="size-8 text-primary"
  >
    <rect x="3" y="3" width="26" height="26" rx="7" />
    <path d="m10 16.5 4 4 8-9" />
  </svg>
);

/**
 * The TODO app with the SDK's standard UI: `AppAccess` beside the app's own
 * header and screen, built from `@sempods/app-ui`. Until a language is
 * picked, in the menu or before sign-in in the settings, the provider follows
 * the browser's language.
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
  const [locale, setLocale] = useState<Language>();

  return (
    <SempodsProvider runtime={runtime} locale={locale}>
      <KitLocale>
        {children}
        <StandardScreen onLocale={setLocale} />
      </KitLocale>
    </SempodsProvider>
  );
}

/**
 * The UI kit's controls and the page follow the provider's locale: React
 * Aria's announcements and formats, and the document language that screen
 * readers pronounce the page in.
 */
function KitLocale({ children }: { readonly children: ReactNode }) {
  const { locale, language } = useSdkLocale();
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  return <I18nProvider locale={locale}>{children}</I18nProvider>;
}

/**
 * The language choice in the gate's settings: plain radio buttons, since a
 * menu or popover would render below the gate.
 */
function LanguageChoices({
  onLocale,
}: {
  readonly onLocale: (locale: Language) => void;
}) {
  const m = useMessages(text);
  const { language } = useSdkLocale();
  return (
    <fieldset className="grid">
      <legend className="mb-1">{m.language}</legend>
      {languages.map(({ code, name }) => (
        <label
          key={code}
          lang={code}
          className="flex min-h-11 cursor-pointer items-center gap-3"
        >
          <input
            type="radio"
            className="size-5 accent-primary"
            name="todo-language"
            checked={language === code}
            onChange={() => onLocale(code)}
          />
          {name}
        </label>
      ))}
    </fieldset>
  );
}

function StandardScreen({
  onLocale,
}: {
  readonly onLocale: (locale: Language) => void;
}) {
  const [open, setOpen] = useState(false);
  // Closing Pods & sharing returns here: the menu item is gone by then.
  const menu = useRef<HTMLButtonElement>(null);
  const { messages, language } = useSdkLocale();
  const { connections } = useAppState();
  const m = useMessages(text);
  // The gate covers the page until a Pod is connected; it has its own settings.
  const header = connections.length > 0;

  return (
    <main className="mx-auto max-w-160 px-4 pt-2 pb-8">
      {header && (
        <header className="flex items-center justify-between gap-2">
          {/* The list switch across the connected Pods, with sharing more. */}
          <ContextSwitch
            title="TODO"
            label={m.list}
            icon={icon}
            texts={{ shareMore: m.shareMore }}
          />
          <HeaderMenu
            ref={menu}
            label={m.menu}
            items={[
              {
                label: messages.controls.dataAccess,
                onSelect: () => setOpen(true),
                icon: <UsersIcon />,
              },
              null,
              {
                label: m.language,
                display: 'section',
                choices: languages.map(({ code, name }) => ({
                  id: code,
                  label: name,
                  checked: language === code,
                  onSelect: () => onLocale(code),
                })),
              },
            ]}
          />
        </header>
      )}
      {/* Startup, sign-in (with the language before it), the list choice,
          prompts and, from the menu, Pods & sharing. */}
      <AppAccess
        appName="TODO"
        icon={icon}
        description={m.description}
        headingLevel={header ? 2 : 1}
        mode="single"
        open={open}
        onClose={() => setOpen(false)}
        focusTarget={menu}
        settings={{
          label: m.settings,
          content: <LanguageChoices onLocale={onLocale} />,
        }}
      />
      <AccessNotice only="write" />
      <TargetScreen>
        <TaskScreen />
      </TargetScreen>
    </main>
  );
}
