// The UI gate's reference screen, ported from the template's spike #120: a
// Focus-like Zen view with a header menu (View submenu with checked choices),
// a routed task dialog holding an SDK ResourceEditor, and a calendar-date
// chooser inside the editor fields. Built with Vite and Tailwind 4 against
// the packed packages; scripts/test-ui-consumer.mjs drives it.
import {
  StrictMode,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRuntime, type BrowserRuntime } from '@sempods/app-sdk';
import {
  AppAccess,
  LoadNotice,
  ResourceEditor,
  SempodsProvider,
  TargetScreen,
  useApp,
  useAppState,
  useContextEditor,
  useList,
  useMessages,
  useSdkLocale,
} from '@sempods/app-sdk/react';
import {
  date,
  fields,
  flag,
  text,
  type DraftOf,
} from '@sempods/client-sdk/edit';
import {
  ActionButton,
  DateChooser,
  HeaderMenu,
  Input,
  ScreenDialog,
  Textarea,
} from '@sempods/app-ui';
import './index.css';

const schema = 'https://schema.org/';
const taskFields = fields(
  {
    title: text(schema + 'name', { language: null, trim: true }),
    description: text(schema + 'description', {
      language: null,
      trim: true,
      optional: true,
    }),
    done: flag(schema + 'actionStatus', {
      on: schema + 'CompletedActionStatus',
      off: schema + 'PotentialActionStatus',
    }),
    // A calendar day that keeps an existing zoned xsd:dateTime unchanged.
    planned: date(schema + 'startDate', { optional: true, orDateTime: true }),
  },
  { type: schema + 'Action' },
);
type TaskDraft = DraftOf<typeof taskFields>;

const texts = {
  en: {
    menu: 'Menu',
    view: 'View',
    zen: 'Zen',
    list: 'List',
    details: 'Details',
    close: 'Close',
    taskMenu: 'Task menu',
    check: 'Check',
    complete: 'Complete',
    notToday: 'Not today',
    previous: 'Previous task',
    next: 'Next task',
    title: 'Title',
    description: 'Description',
    planned: 'Start considering',
    emptyZen: 'Enjoy your day.',
  },
  de: {
    menu: 'Menü',
    view: 'Ansicht',
    zen: 'Zen',
    list: 'Liste',
    details: 'Details',
    close: 'Schließen',
    taskMenu: 'Aufgabenmenü',
    check: 'Prüfen',
    complete: 'Erledigen',
    notToday: 'Nicht heute',
    previous: 'Vorherige Aufgabe',
    next: 'Nächste Aufgabe',
    title: 'Titel',
    description: 'Beschreibung',
    planned: 'Vormerken ab',
    emptyZen: 'Genieß deinen Tag.',
  },
};

/*
 * The route lives in the query: ?task=<iri>&view=list. As in the template's
 * routes.ts, every switch, Back and Forward runs through the SDK's navigate:
 * an unsaved edit asks first, and staying keeps the view, its address and
 * the history (the shown entry's position is kept in history.state).
 */
let shown = location.search;
let position: number =
  (history.state as { position?: number } | null)?.position ?? 0;
// Set while the router itself undoes a step, whose popstate it ignores.
let undoing = false;
const listeners = new Set<() => void>();
function show(search: string) {
  shown = search;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
function useRoute() {
  const search = useSyncExternalStore(subscribe, () => shown);
  const params = new URLSearchParams(search);
  const { navigate } = useApp();
  useEffect(() => {
    const onPop = () => {
      if (undoing) {
        undoing = false;
        return;
      }
      const to = location.search;
      const target: number =
        (history.state as { position?: number } | null)?.position ?? 0;
      void navigate(() => {
        position = target;
        show(to);
      }).then((left) => {
        // Staying: step back to the shown entry; the history stays intact.
        if (left || target === position) return;
        undoing = true;
        history.go(position - target);
      });
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, [navigate]);
  const go = useCallback(
    (changes: Record<string, string | null>) => {
      const next = new URLSearchParams(location.search);
      for (const [key, value] of Object.entries(changes))
        if (value === null) next.delete(key);
        else next.set(key, value);
      void navigate(() => {
        position += 1;
        history.pushState({ position }, '', '?' + next.toString());
        show(location.search);
      });
    },
    [navigate],
  );
  return { params, go };
}
type Route = ReturnType<typeof useRoute>;

const Icon = ({ path }: { readonly path: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={path} />
  </svg>
);

let runtime: BrowserRuntime | undefined;

function App() {
  runtime ??= createBrowserRuntime({
    identity: {
      kind: 'dynamic',
      name: 'UI gate',
      redirectUri: location.origin + '/callback',
    },
    returnTo: '/',
    development: 'loopback-http',
  });
  const query = new URLSearchParams(location.search);
  const language = query.get('lang') === 'de' ? 'de' : 'en';
  document.documentElement.lang = language;
  // The checks pick the theme and the variants from the address.
  for (const key of ['theme', 'actions', 'secondary']) {
    const value = query.get(key);
    if (value) document.documentElement.dataset[key] = value;
  }
  return (
    <SempodsProvider
      runtime={runtime}
      language={language}
      locale={language === 'de' ? 'de-DE' : 'en-GB'}
    >
      <Frame />
    </SempodsProvider>
  );
}

function Frame() {
  const [managing, setManaging] = useState(false);
  const { connections } = useAppState();
  const { messages } = useSdkLocale();
  const t = useMessages(texts);
  const route = useRoute();
  const view = route.params.get('view') === 'list' ? 'list' : 'zen';
  const header = connections.length > 0;
  return (
    <main className="gate-main" data-view={view}>
      {header && (
        <header className="gate-header">
          <h1>Focus</h1>
          <HeaderMenu
            label={t.menu}
            items={[
              {
                label: t.view,
                choices: [
                  {
                    label: t.zen,
                    checked: view === 'zen',
                    onSelect: () => route.go({ view: null }),
                  },
                  {
                    label: t.list,
                    checked: view === 'list',
                    onSelect: () => route.go({ view: 'list' }),
                  },
                ],
              },
              null,
              {
                label: messages.controls.dataAccess,
                onSelect: () => setManaging(true),
              },
            ]}
          />
        </header>
      )}
      <AppAccess
        appName="Focus"
        description="UI gate"
        headingLevel={header ? 2 : 1}
        open={managing}
        onClose={() => setManaging(false)}
      />
      <TargetScreen>
        <Tasks view={view} route={route} />
      </TargetScreen>
    </main>
  );
}

function Tasks({
  view,
  route,
}: {
  readonly view: 'zen' | 'list';
  readonly route: Route;
}) {
  const t = useMessages(texts);
  const list = useList(taskFields);
  const [index, setIndex] = useState(0);
  const { view: target } = useAppState();
  const items = (list.data?.items ?? []).filter((item) => !item.data.done);
  const active = items[index % Math.max(items.length, 1)];
  const open = (iri: string) => route.go({ task: iri });
  const subject = route.params.get('task');
  return (
    <>
      <LoadNotice {...list} />
      {view === 'list' ? (
        <ul className="gate-list">
          {items.map((item) => (
            <li key={item.iri}>
              <a
                href={`?task=${encodeURIComponent(item.iri)}&view=list`}
                onClick={(event) => {
                  event.preventDefault();
                  open(item.iri);
                }}
              >
                {item.data.title}
              </a>
            </li>
          ))}
        </ul>
      ) : active ? (
        <section className="zen" aria-label={t.zen}>
          <div className="zen-task">
            <p className="zen-position" aria-live="polite">
              {(index % items.length) + 1}/{items.length}
            </p>
            <h2>
              <a
                className="zen-title"
                href={`?task=${encodeURIComponent(active.iri)}`}
                onClick={(event) => {
                  event.preventDefault();
                  open(active.iri);
                }}
              >
                {active.data.title}
              </a>
            </h2>
          </div>
          <div className="zen-dock">
            <div className="zen-primary">
              <ActionButton shape="round-lg" label={t.complete}>
                <Icon path="M5 12.5l4.5 4.5L19 7.5" />
              </ActionButton>
            </div>
            <div className="zen-actions">
              <ActionButton
                variant="secondary"
                shape="round"
                label={t.previous}
                onPress={() =>
                  setIndex((i) => (i + items.length - 1) % items.length)
                }
              >
                <Icon path="M15 18l-6-6 6-6" />
              </ActionButton>
              <ActionButton
                variant="secondary"
                onPress={() => open(active.iri)}
              >
                {t.notToday}
              </ActionButton>
              <ActionButton
                variant="secondary"
                shape="round"
                label={t.next}
                onPress={() => setIndex((i) => (i + 1) % items.length)}
              >
                <Icon path="M9 18l6-6-6-6" />
              </ActionButton>
            </div>
          </div>
        </section>
      ) : (
        list.state.kind === 'ready' && <p className="zen-empty">{t.emptyZen}</p>
      )}
      {target && (
        <TaskDialog
          route={route}
          subject={subject}
          context={target.contextIri}
          reload={list.reload}
        />
      )}
    </>
  );
}

function TaskDialog({
  route,
  subject,
  context,
  reload,
}: {
  readonly route: Route;
  readonly subject: string | null;
  readonly context: string;
  readonly reload: () => unknown;
}) {
  const t = useMessages(texts);
  const edit = useContextEditor(taskFields);
  const { open, close: closeEditor } = edit;
  const { changing } = useAppState();
  const [checked, setChecked] = useState(0);
  useEffect(() => {
    if (changing) return;
    if (subject) void open({ subject, context });
    else void closeEditor();
  }, [subject, context, changing, open, closeEditor]);
  const editor =
    subject && edit.target?.subject === subject ? edit.editor : null;
  // Guarded: the SDK asks before a dirty draft is discarded.
  const requestClose = async () => {
    if (await edit.close()) {
      route.go({ task: null });
      void reload();
    }
  };
  return (
    <ScreenDialog
      title={t.details}
      closeLabel={t.close}
      open={!!subject}
      onRequestClose={() => void requestClose()}
      actions={
        <HeaderMenu
          label={t.taskMenu}
          icon="more"
          items={[{ label: t.check, onSelect: () => setChecked((n) => n + 1) }]}
        />
      }
    >
      <output hidden data-testid="checked">
        {checked}
      </output>
      <ResourceEditor
        editor={editor}
        quiet
        onClose={() => void requestClose()}
        labels={{
          title: t.title,
          description: t.description,
          planned: t.planned,
        }}
      >
        {(draft, change) => <TaskInputs draft={draft} change={change} />}
      </ResourceEditor>
    </ScreenDialog>
  );
}

function TaskInputs({
  draft,
  change,
}: {
  readonly draft: TaskDraft;
  readonly change: (draft: TaskDraft) => void;
}) {
  const t = useMessages(texts);
  const update = (values: Partial<TaskDraft>) =>
    change({ ...draft, ...values });
  return (
    <div className="task-fields">
      <label>
        {t.title}
        <Input
          value={draft.title}
          onChange={(event) => update({ title: event.target.value })}
          required
        />
      </label>
      <label>
        {t.description}
        <Textarea
          rows={2}
          value={draft.description ?? ''}
          onChange={(event) => update({ description: event.target.value })}
        />
      </label>
      <DateChooser
        label={t.planned}
        value={draft.planned}
        onChange={(planned) => update({ planned })}
        optional
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
