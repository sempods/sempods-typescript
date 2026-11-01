// The UI gate's reference screen, ported from the template's spike #120: a
// Focus-like Zen view and a List view switched from a header menu (View
// submenu with checked choices), a routed task dialog holding an SDK
// ResourceEditor, its "Not today" action address, a creation address and
// explicit not-found pages, a calendar-date chooser inside the editor fields.
// Built with Vite and Tailwind 4 against the packed packages;
// scripts/test-ui-consumer.mjs drives it. The task dialog, task-dialog.tsx,
// and the address model, places.ts, are the package README's examples, which
// the test writes next to this file as they are shipped; the package's
// router moves between the places.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRuntime, type BrowserRuntime } from '@sempods/app-sdk';
import {
  AppAccess,
  LoadNotice,
  SempodsProvider,
  TargetScreen,
  useAppState,
  useList,
  useMessages,
  useSdkLocale,
} from '@sempods/app-sdk/react';
import {
  ActionButton,
  HeaderMenu,
  ScreenDialog,
  replaceUrl,
  useNav,
  type Nav,
} from '@sempods/app-ui';
import { places, type Place } from './places';
import { TaskDialog, taskFields } from './task-dialog';
import './index.css';

const texts = {
  en: {
    menu: 'Menu',
    view: 'View',
    zen: 'Zen',
    list: 'List',
    complete: 'Complete',
    notToday: 'Not today',
    previous: 'Previous task',
    next: 'Next task',
    emptyZen: 'Enjoy your day.',
    newTask: 'New task',
    newTaskText: 'A new task would be written here.',
    notFound: 'Not found',
    invalid: 'This task link is not valid.',
    unknown: 'This address does not lead anywhere in Focus.',
  },
  de: {
    menu: 'Menü',
    view: 'Ansicht',
    zen: 'Zen',
    list: 'Liste',
    complete: 'Erledigen',
    notToday: 'Nicht heute',
    previous: 'Vorherige Aufgabe',
    next: 'Nächste Aufgabe',
    emptyZen: 'Genieß deinen Tag.',
    newTask: 'Neue Aufgabe',
    newTaskText: 'Hier entstünde eine neue Aufgabe.',
    notFound: 'Nicht gefunden',
    invalid: 'Dieser Aufgabenlink ist nicht gültig.',
    unknown: 'Diese Adresse führt in Focus nirgendwohin.',
  },
};

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

// The checks pick the language, the theme and the variants with the address
// they load; the address model does not know these, so the router replaces
// them by the canonical address. Read once, at load.
const settings = new URLSearchParams(location.search);
const language = settings.get('lang') === 'de' ? 'de' : 'en';
document.documentElement.lang = language;
for (const key of ['theme', 'actions', 'secondary']) {
  const value = settings.get(key);
  if (value) document.documentElement.dataset[key] = value;
}

let runtime: BrowserRuntime | undefined;

function App() {
  runtime ??= createBrowserRuntime({
    identity: {
      kind: 'dynamic',
      name: 'UI gate',
      redirectUri: location.origin + '/callback',
    },
    // Sign-in returns to the address it started from, a task link included,
    // never to the callback.
    returnTo: () =>
      location.pathname.startsWith('/callback')
        ? '/'
        : location.pathname + location.search,
    replaceUrl,
    development: 'loopback-http',
  });
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
  const nav = useNav(places);
  const { place } = nav;
  // A screen above a view keeps the view it opened from.
  const [view, setView] = useState<'zen' | 'list'>('zen');
  if ((place.kind === 'zen' || place.kind === 'list') && place.kind !== view)
    setView(place.kind);
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
                    onSelect: () => nav.go({ kind: 'zen' }),
                  },
                  {
                    label: t.list,
                    checked: view === 'list',
                    onSelect: () => nav.go({ kind: 'list' }),
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
        <Tasks view={view} nav={nav} />
      </TargetScreen>
      {/* Signed out, sign-in stays usable: the error shows once connected. */}
      {place.kind === 'not-found' && header && (
        <ScreenDialog
          title={t.notFound}
          open
          onRequestClose={() => nav.go({ kind: 'zen' }, { replace: true })}
        >
          <p>{place.reason === 'invalid' ? t.invalid : t.unknown}</p>
        </ScreenDialog>
      )}
    </main>
  );
}

function Tasks({
  view,
  nav,
}: {
  readonly view: 'zen' | 'list';
  readonly nav: Nav<Place>;
}) {
  const t = useMessages(texts);
  const list = useList(taskFields);
  const [index, setIndex] = useState(0);
  const { view: target } = useAppState();
  const items = (list.data?.items ?? []).filter((item) => !item.data.done);
  const at = index % Math.max(items.length, 1);
  const active = items[at];
  const { place } = nav;
  // Links name the Context the list reads, so the address keeps its source.
  const task = (subject: string, action?: 'postpone'): Place => ({
    kind: 'task',
    subject,
    ...(target ? { context: target.contextIri } : {}),
    ...(action ? { action } : {}),
  });
  return (
    <>
      <LoadNotice {...list} />
      {view === 'list' ? (
        <ul className="gate-list">
          {items.map((item) => (
            <li key={item.iri}>
              <a {...nav.link(task(item.iri))}>{item.data.title}</a>
            </li>
          ))}
        </ul>
      ) : active ? (
        <section className="zen" aria-label={t.zen}>
          <div className="zen-task">
            <p className="zen-position" aria-live="polite">
              {at + 1}/{items.length}
            </p>
            <h2>
              <a className="zen-title" {...nav.link(task(active.iri))}>
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
                onPress={() => nav.go(task(active.iri, 'postpone'))}
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
          subject={place.kind === 'task' ? place.subject : null}
          // The Context the address names, else the selected one.
          context={
            (place.kind === 'task' && place.context) || target.contextIri
          }
          title={
            place.kind === 'task' && place.action === 'postpone'
              ? t.notToday
              : undefined
          }
          leave={() => {
            nav.close({ kind: 'zen' });
            void list.reload();
          }}
        />
      )}
      <ScreenDialog
        title={t.newTask}
        open={place.kind === 'new'}
        onRequestClose={() => nav.close({ kind: 'zen' })}
      >
        <p>{t.newTaskText}</p>
      </ScreenDialog>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
