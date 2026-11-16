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
import {
  applyAppearance,
  readAppearance,
  type Appearance,
} from './appearance.js';
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
    finished: 'Done',
    menu: 'Menu',
    settings: 'Settings',
    language: 'Language',
    appearance: 'Appearance',
    system: 'System',
    light: 'Light',
    dark: 'Dark',
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
    finished: 'Erledigt',
    menu: 'Menü',
    settings: 'Einstellungen',
    language: 'Sprache',
    appearance: 'Erscheinungsbild',
    system: 'System',
    light: 'Hell',
    dark: 'Dunkel',
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

  const field = useRef<HTMLInputElement>(null);
  // Sections follow what each row shows: a confirmed tick moves its task at
  // once, also when the list's next read is late or fails.
  const rows = (tasks ?? []).map((item) => ({ item, row: mutate.for(item) }));
  const open = rows.filter(({ row }) => !row.data.done);
  const done = rows.filter(({ row }) => row.data.done);
  const row = ({ item, row }: (typeof rows)[number]) => (
    <TaskRow
      key={item.iri}
      row={row}
      editing={selected === item.iri ? editing : null}
      onOpen={() => void select(item.iri)}
    />
  );

  return (
    <section aria-label={m.tasks}>
      {/* The new task comes first. Add stays available: with nothing to add
          it moves the focus into the field instead of being greyed out. */}
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (creation.canCreate) void creation.create();
          else field.current?.focus();
        }}
      >
        <Input
          ref={field}
          aria-label={m.newTask}
          placeholder={m.newTask}
          className="h-11 flex-1"
          disabled={!creation.canEdit}
          value={creation.draft.title}
          onChange={(e) => creation.change({ title: e.target.value })}
        />
        {/* Locked only while a creation is sent or unresolved. A creation
            found absent keeps the field locked and Add for its retry. */}
        <ActionButton
          type="submit"
          shape="round-sm"
          label={m.add}
          isDisabled={!creation.canEdit && !creation.canCreate}
        >
          <PlusIcon />
        </ActionButton>
      </form>
      <UpdateNotice {...creation.notice} quiet />
      <LoadNotice {...list} />
      {/* Empty only when confirmed: not on a failure, nor with skipped entries. */}
      {(list.state.kind === 'ready' || list.state.kind === 'loading') &&
        tasks?.length === 0 &&
        list.data?.skipped === 0 && (
          <p className="py-6 text-center text-muted-foreground">{m.empty}</p>
        )}
      <ul className="my-4">{open.map(row)}</ul>
      {/* Done tasks stay visible below the open ones, quieter. */}
      {done.length > 0 && (
        <section aria-labelledby="todo-finished">
          <h2
            id="todo-finished"
            className="mt-6 px-1 text-sm font-medium text-muted-foreground"
          >
            {m.finished}
          </h2>
          <ul className="mb-4">{done.map(row)}</ul>
        </section>
      )}
      {/* An unresolved tick or delete whose task left the list keeps its recovery. */}
      <UnresolvedNotices of={mutate} shown={tasks} />
      {/* A row that left the list (deleted elsewhere) keeps its editor. */}
      {selected && !tasks?.some((item) => item.iri === selected) && editing}
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
const appearances = ['system', 'light', 'dark'] as const;

/** The app's device-local settings and how to change them. */
interface Settings {
  readonly onLocale: (locale: Language) => void;
  readonly appearance: Appearance;
  readonly onAppearance: (appearance: Appearance) => void;
}

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
  // The appearance is kept on this device; the entry applies it before the
  // first render.
  const [appearance, setAppearance] = useState(readAppearance);
  const onAppearance = (next: Appearance) => {
    applyAppearance(next);
    setAppearance(next);
  };

  return (
    <SempodsProvider runtime={runtime} locale={locale}>
      <KitLocale>
        {children}
        <StandardScreen
          onLocale={setLocale}
          appearance={appearance}
          onAppearance={onAppearance}
        />
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
 * The settings in the access gate's dialog: plain radio buttons, since a menu
 * or popover would render below the gate. The header menu offers the same.
 */
function SettingChoices({ onLocale, appearance, onAppearance }: Settings) {
  const m = useMessages(text);
  const { language } = useSdkLocale();
  const choice = 'flex min-h-11 cursor-pointer items-center gap-3';
  return (
    <div className="grid gap-4">
      <fieldset className="grid">
        <legend className="mb-1">{m.language}</legend>
        {languages.map(({ code, name }) => (
          <label key={code} lang={code} className={choice}>
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
      <fieldset className="grid">
        <legend className="mb-1">{m.appearance}</legend>
        {appearances.map((value) => (
          <label key={value} className={choice}>
            <input
              type="radio"
              className="size-5 accent-primary"
              name="todo-appearance"
              checked={appearance === value}
              onChange={() => onAppearance(value)}
            />
            {m[value]}
          </label>
        ))}
      </fieldset>
    </div>
  );
}

function StandardScreen(settings: Settings) {
  const { onLocale, appearance, onAppearance } = settings;
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
              {
                label: m.appearance,
                display: 'section',
                choices: appearances.map((value) => ({
                  id: value,
                  label: m[value],
                  checked: appearance === value,
                  onSelect: () => onAppearance(value),
                })),
              },
            ]}
          />
        </header>
      )}
      {/* Startup, sign-in (with the language before it), the list
          catalogue's loading and failure states, prompts and, from the menu,
          Pods & sharing. The header's switch chooses the list. */}
      <AppAccess
        appName="TODO"
        icon={icon}
        description={m.description}
        mode="single"
        open={open}
        onClose={() => setOpen(false)}
        focusTarget={menu}
        settings={{
          label: m.settings,
          content: <SettingChoices {...settings} />,
        }}
      />
      <AccessNotice only="write" />
      <TargetScreen>
        <TaskScreen />
      </TargetScreen>
    </main>
  );
}
