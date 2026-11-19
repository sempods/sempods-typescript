// The UI gate's reference screen, ported from the template's spike #120: a
// Focus-like Zen view with its actions in a group and a List view with
// filter chips, switched from a header menu (View submenu with checked
// choices), a routed task dialog holding an SDK
// ResourceEditor, its "Not today" action address, a creation address and
// explicit not-found pages, a calendar-date chooser inside the editor fields.
// With `?dialog=compact`, a task address opens the compact quick edit
// instead of the task dialog. With `?workspace`, the screen is the README's
// workspace with its nonmodal filter panel instead of the tasks. With
// `?screen=search`, the page is a search bar with suggestions (SuggestField)
// whose results the checks set through `window.searchGate`, as an app's
// search would, with a photo or a type icon per suggestion and a notice
// under them (#361); with `&mode=address` as well, the bar sits in a nonmodal
// panel and searches only text that is no address and at least two
// characters long, as an address bar does, and Ctrl/Cmd-K focuses and
// selects it. With `?screen=checkbox`, the page is ticked rows with the
// kit's Checkbox. The access gate offers the app's language and appearance
// settings (`AppAccess` `settings`), applied in place. With
// `?screen=gate-settings`, sign-in is optional and the page is only the
// gate with a fixed focus target; the checks end the gate's cause through
// `window.gateRuntime`, as the app's own code could. With `?screen=add-pod`,
// the page is a multi-Pod app's sources panel (a nonmodal WorkspacePanel)
// listing the connected Pods, with the SDK's PodChooser to add another one
// while signed in (#329). With `?screen=tabs`, the page is the README's
// views as links: the two views as ghost links, the shown one marked by
// `nav.link`, and a link to a task, a screen over a view (#342, #343).
// With `?screen=confirm`, the page is the README's confirmation, open, with
// long German labels and a long unbroken list name; with `&footer=pill` as
// well, the same dialog parts hold `ActionButton` pills instead (#368).
// With `?screen=menu-confirm`, a screen's menu has an action that asks
// first with the README's confirmation (#391).
// With `?screen=ghost`, the page is the ghost variant's icon actions, a
// Button, a LinkButton, an ActionButton and a HeaderMenu, beside a native
// button; the checks swap the stylesheet for no-preflight.css, a host that
// imports only Tailwind's theme and utilities (#392).
// Built with Vite and Tailwind 4 against the packed packages;
// scripts/test-ui-consumer.mjs drives it. The task dialog, task-dialog.tsx,
// the quick edit, quick-edit.tsx, the workspace, workspace.tsx, the view
// links, view-tabs.tsx, the confirmation, confirm-dialog.tsx, and the
// address model, places.ts, are the package
// README's examples, which
// the test writes next to this file as they are shipped; the package's
// router moves between the places.
import {
  StrictMode,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';
import { UsersIcon } from 'lucide-react';
import { createBrowserRuntime, type BrowserRuntime } from '@sempods/app-sdk';
import {
  AppAccess,
  LoadNotice,
  PodChooser,
  SempodsProvider,
  TargetScreen,
  useAppState,
  useList,
  useMessages,
  useSdkLocale,
} from '@sempods/app-sdk/react';
import {
  ActionButton,
  ActionGroup,
  Button,
  Checkbox,
  Chip,
  ChipGroup,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  HeaderMenu,
  LinkButton,
  ScreenDialog,
  SuggestField,
  WorkspacePanel,
  replaceUrl,
  useNav,
  type Nav,
  type Suggestion,
} from '@sempods/app-ui';
import { places, type Place } from './places';
import { checkTheme, readTheme } from '@sempods/app-ui/theme-check';
import { TaskDialog, taskFields } from './task-dialog';
import { QuickEdit } from './quick-edit';
import { Workspace } from './workspace';
import { ViewTabs } from './view-tabs';
import { ConfirmDialog } from './confirm-dialog';
import './index.css';
import { ContextSwitchGate } from './context-switch';
import { MenuConfirmGate } from './menu-confirm';

Object.assign(window, { checkTheme, readTheme });

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
    actions: 'Task actions',
    show: 'Show',
    open: 'Open',
    all: 'All',
    more: 'more',
    priority: 'Priority',
    high: 'High',
    normal: 'Normal',
    urgent: 'Urgent',
    needsDue: 'Needs a due date',
    details: 'Open details',
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
    actions: 'Aufgabenaktionen',
    show: 'Anzeigen',
    open: 'Offen',
    all: 'Alle',
    more: 'mehr',
    priority: 'Priorität',
    high: 'Hoch',
    normal: 'Normal',
    urgent: 'Dringend',
    needsDue: 'Braucht ein Fälligkeitsdatum',
    details: 'Details öffnen',
  },
};

/**
 * A row's quiet menu (#145): a section of choices with an unavailable one
 * (#116, #141) and an action. The priority stays in the page.
 */
function RowMenu({
  title,
  open,
}: {
  readonly title: string;
  readonly open: () => void;
}) {
  const t = useMessages(texts);
  const [priority, setPriority] = useState<'high' | 'normal'>('normal');
  return (
    <HeaderMenu
      icon="more"
      variant="ghost"
      label={`${title}: ${t.more}`}
      items={[
        {
          label: t.priority,
          display: 'section',
          choices: [
            {
              id: 'high',
              label: t.high,
              checked: priority === 'high',
              onSelect: () => setPriority('high'),
            },
            {
              id: 'normal',
              label: t.normal,
              checked: priority === 'normal',
              onSelect: () => setPriority('normal'),
            },
            {
              id: 'urgent',
              label: t.urgent,
              description: t.needsDue,
              checked: false,
              disabled: true,
              onSelect: () => {},
            },
          ],
        },
        null,
        { label: t.details, onSelect: open },
      ]}
    />
  );
}

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
if (settings.get('screen') === 'contexts')
  sessionStorage.setItem('contexts-gate', settings.toString());
const contextSettings =
  location.pathname === '/callback'
    ? new URLSearchParams(sessionStorage.getItem('contexts-gate') ?? '')
    : settings;
const contextSwitch = contextSettings.get('screen') === 'contexts';
const language =
  (contextSwitch ? contextSettings : settings).get('lang') === 'de'
    ? 'de'
    : 'en';
const compact = settings.get('dialog') === 'compact';
const workspace = settings.has('workspace');
const search = settings.get('screen') === 'search';
const addressBar = search && settings.get('mode') === 'address';
const gateSettings = settings.get('screen') === 'gate-settings';
// The sign-in callback returns to the sources panel it started from.
if (settings.get('screen') === 'add-pod')
  sessionStorage.setItem('add-pod-gate', '1');
const addPod =
  settings.get('screen') === 'add-pod' ||
  (location.pathname === '/callback' &&
    sessionStorage.getItem('add-pod-gate') === '1');
const checkboxes = settings.get('screen') === 'checkbox';
const tabs = settings.get('screen') === 'tabs';
const confirmation = settings.get('screen') === 'confirm';
const menuConfirm = settings.get('screen') === 'menu-confirm';
const ghosts = settings.get('screen') === 'ghost';
document.documentElement.lang = language;
for (const key of ['theme', 'actions', 'secondary']) {
  const value = settings.get(key);
  if (value) document.documentElement.dataset[key] = value;
}

let runtime: BrowserRuntime | undefined;

/**
 * The app's own device-local settings, as Focus offers them before sign-in:
 * applied at once, with plain radio buttons (no portal), in the gate's
 * settings dialog.
 */
function SettingsChoices({
  lang,
  setLang,
}: {
  lang: 'en' | 'de';
  setLang: (value: 'en' | 'de') => void;
}) {
  // screen.css maps the choice to color-scheme, in a stylesheet rule that
  // the build's light-dark() fallback follows (as Focus does).
  const [scheme, setScheme] = useState(
    () => document.documentElement.dataset.appearance ?? 'system',
  );
  const choose = (value: string) => {
    if (value === 'system') delete document.documentElement.dataset.appearance;
    else document.documentElement.dataset.appearance = value;
    setScheme(value);
  };
  const de = lang === 'de';
  return (
    <>
      <fieldset>
        <legend>{de ? 'Sprache' : 'Language'}</legend>
        {(
          [
            ['en', 'English'],
            ['de', 'Deutsch'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} lang={value}>
            <input
              type="radio"
              name="gate-language"
              checked={lang === value}
              onChange={() => setLang(value)}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>{de ? 'Erscheinungsbild' : 'Appearance'}</legend>
        {(
          [
            ['system', 'System'],
            ['light', de ? 'Hell' : 'Light'],
            ['dark', de ? 'Dunkel' : 'Dark'],
          ] as const
        ).map(([value, label]) => (
          <label key={value}>
            <input
              type="radio"
              name="gate-appearance"
              checked={scheme === value}
              onChange={() => choose(value)}
            />
            {label}
          </label>
        ))}
      </fieldset>
    </>
  );
}

function App() {
  // Changing the language re-renders the provider; the runtime stays.
  const [lang, setLang] = useState<'en' | 'de'>(language);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
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
    // Reading without a token: opening a Pod ends the gate in place.
    ...(gateSettings ? { signIn: 'optional' as const } : {}),
  });
  if (gateSettings) Object.assign(window, { gateRuntime: runtime });
  const appSettings = {
    label: lang === 'de' ? 'Einstellungen' : 'Settings',
    content: <SettingsChoices lang={lang} setLang={setLang} />,
  };
  return (
    <SempodsProvider
      runtime={runtime}
      // A TargetScreen asks for a Context; a task address with its source
      // opens without one.
      contextSelection="on-demand"
      language={lang}
      locale={lang === 'de' ? 'de-DE' : 'en-GB'}
    >
      {contextSwitch ? (
        <ContextSwitchGate />
      ) : search ? (
        <SearchGate />
      ) : checkboxes ? (
        <CheckboxGate />
      ) : tabs ? (
        <TabsGate />
      ) : ghosts ? (
        <GhostGate />
      ) : confirmation ? (
        <ConfirmGate pills={settings.get('footer') === 'pill'} />
      ) : menuConfirm ? (
        <MenuConfirmGate />
      ) : gateSettings ? (
        <GateSettingsScreen settings={appSettings} />
      ) : addPod ? (
        <AddPodScreen />
      ) : (
        <Frame settings={appSettings} />
      )}
    </SempodsProvider>
  );
}

function Frame({
  settings,
}: {
  settings: { readonly label: string; readonly content: ReactNode };
}) {
  const [managing, setManaging] = useState(false);
  // Closing Pods & sharing returns here: the menu item is gone by then.
  const menu = useRef<HTMLButtonElement>(null);
  const { connections, view: target } = useAppState();
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
            ref={menu}
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
                // Decorative: the label stays the item's name (#231).
                icon: <UsersIcon />,
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
        focusTarget={menu}
        settings={settings}
      />
      {/* An address that names its source opens without a selected Context:
          no TargetScreen, so AppAccess asks for no choice. */}
      {workspace ? (
        header && (
          <div className="gate-workspace">
            <Workspace />
            {/* After the panel in the tab order, so leaving it forward lands
                in the page, not in the browser's own controls, where
                engines differ in what they report as focused. */}
            <a href="#after-workspace" id="after-workspace" className="sr-only">
              After the workspace
            </a>
          </div>
        )
      ) : place.kind === 'task' && place.context && !target ? (
        header && (
          <TaskDialog
            subject={place.subject}
            context={place.context}
            title={place.action === 'postpone' ? t.notToday : undefined}
            leave={() => nav.close({ kind: 'zen' })}
          />
        )
      ) : (
        <TargetScreen>
          <Tasks view={view} nav={nav} />
        </TargetScreen>
      )}
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
  const [shown, setShown] = useState<'open' | 'all'>('open');
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
        <>
          <ChipGroup
            label={t.show}
            className="mb-2"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[shown]}
            onSelectionChange={(keys) =>
              setShown(keys.has('all') ? 'all' : 'open')
            }
          >
            <Chip id="open">{t.open}</Chip>
            <Chip id="all">{t.all}</Chip>
          </ChipGroup>
          <ul className="gate-list">
            {(shown === 'all' ? (list.data?.items ?? []) : items).map(
              (item) => (
                <li key={item.iri}>
                  <a {...nav.link(task(item.iri))}>{item.data.title}</a>
                  <RowMenu
                    title={item.data.title}
                    open={() => nav.go(task(item.iri))}
                  />
                </li>
              ),
            )}
          </ul>
        </>
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
            <ActionGroup label={t.actions}>
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
            </ActionGroup>
          </div>
        </section>
      ) : (
        list.state.kind === 'ready' && <p className="zen-empty">{t.emptyZen}</p>
      )}
      {target && compact && (
        <QuickEdit
          subject={place.kind === 'task' ? place.subject : null}
          context={
            (place.kind === 'task' && place.context) || target.contextIri
          }
          leave={() => {
            nav.close({ kind: 'zen' });
            void list.reload();
          }}
        />
      )}
      {target && !compact && (
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

/** A suggestion as the checks set it: `picture` stands for its `media`. */
type GateSuggestion = Omit<Suggestion, 'media'> & {
  readonly picture?: 'photo' | 'icon';
};

/** What the app's search has found for the typed text, set by the checks. */
interface SearchState {
  readonly items: readonly GateSuggestion[];
  readonly loading?: boolean;
  readonly failed?: 'some' | 'all';
  readonly notice?: string;
}

/** A photo wider than the box, as a person's picture usually is. */
const photo =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#c2410c"/><circle cx="40" cy="24" r="12" fill="#fed7aa"/></svg>',
  );

/** The suggestions with their media, as an app renders them. */
function withMedia(items: readonly GateSuggestion[]): Suggestion[] {
  return items.map(({ picture, ...item }) => ({
    ...item,
    ...(picture === 'photo'
      ? { media: <img src={photo} alt="" loading="lazy" /> }
      : picture === 'icon'
        ? { media: <UsersIcon className="size-5" /> }
        : {}),
  }));
}

/**
 * A multi-Pod app's sources panel, as Explorer's: the connected Pods with
 * their session, and the SDK's chooser to add another one while signed in.
 */
function AddPodScreen() {
  const { connections } = useAppState();
  const [closed, setClosed] = useState(0);
  return (
    <main className="gate-main">
      <AppAccess appName="Explorer" />
      {connections.some((c) => c.session.kind === 'active') && (
        <WorkspacePanel
          title="Sources"
          open
          onRequestClose={() => setClosed((n) => n + 1)}
        >
          <ul aria-label="Connected Pods" className="mb-4">
            {connections.map((c) => (
              <li key={c.id} data-session={c.session.kind}>
                {c.podUrl}
              </li>
            ))}
          </ul>
          <PodChooser />
          <p data-testid="panel-closed" className="sr-only">
            {closed}
          </p>
        </WorkspacePanel>
      )}
    </main>
  );
}

/** Only the gate with the app's settings, and a target outside it. */
function GateSettingsScreen({
  settings,
}: {
  settings: { readonly label: string; readonly content: ReactNode };
}) {
  const target = useRef<HTMLButtonElement>(null);
  return (
    <main className="gate-main">
      <button ref={target} type="button" id="gate-focus-target">
        Back to the app
      </button>
      <AppAccess appName="Focus" settings={settings} focusTarget={target} />
    </main>
  );
}

/**
 * Ticked rows as a list app has them (`?screen=checkbox`): the box named by
 * the row's title, a disabled row, and a box with a visible label.
 */
function CheckboxGate() {
  const [done, setDone] = useState({ milk: false, bread: true });
  const [remember, setRemember] = useState(false);
  return (
    <main className="gate-main">
      <ul aria-label="Tasks">
        {(
          [
            ['milk', 'Buy milk'],
            ['bread', 'Buy bread'],
          ] as const
        ).map(([key, title]) => (
          <li key={key} className="flex min-h-12 items-center gap-3 px-3">
            <Checkbox
              aria-label={`Done: ${title}`}
              isSelected={done[key]}
              onChange={(next) => setDone({ ...done, [key]: next })}
            />
            <span>{title}</span>
          </li>
        ))}
        <li className="flex min-h-12 items-center gap-3 px-3">
          <Checkbox aria-label="Done: Locked" isSelected isDisabled />
          <span>Locked</span>
        </li>
      </ul>
      <div className="flex min-h-12 items-center gap-3 px-3">
        <Checkbox
          aria-labelledby="remember-device"
          isSelected={remember}
          onChange={setRemember}
        />
        <span id="remember-device">Remember this device</span>
      </div>
    </main>
  );
}

/** One unbroken name, as a list or resource name may be (#368). */
const longName = 'Wocheneinkauf-' + 'GemüseObstGetränkeDrogerie'.repeat(4);

/**
 * A short confirmation with Konsum's labels (#368), open at load: the
 * README's `ConfirmDialog`, or with `pills` the same dialog parts holding
 * `ActionButton` pills. The answer shows on the page; the button reopens it.
 */
function ConfirmGate({ pills }: { readonly pills: boolean }) {
  const [open, setOpen] = useState(true);
  const [answer, setAnswer] = useState('none');
  const title = 'Gekaufte Artikel löschen?';
  const text = `Alle gekauften Artikel aus „${longName}“ werden gelöscht.`;
  const confirm = () => setAnswer('confirmed');
  return (
    <main className="gate-main">
      <button className="min-h-11" onClick={() => setOpen(true)}>
        Bestätigung öffnen
      </button>
      <output data-answer={answer}>{answer}</output>
      {pills ? (
        <Dialog isOpen={open} onOpenChange={setOpen} showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{text}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <ActionButton variant="secondary" slot="close">
              Abbrechen
            </ActionButton>
            <ActionButton slot="close" onPress={confirm}>
              Gekaufte Artikel löschen
            </ActionButton>
          </DialogFooter>
        </Dialog>
      ) : (
        <ConfirmDialog
          isOpen={open}
          onOpenChange={setOpen}
          title={title}
          cancel="Abbrechen"
          confirm="Gekaufte Artikel löschen"
          onConfirm={confirm}
        >
          {text}
        </ConfirmDialog>
      )}
    </main>
  );
}

/**
 * The ghost variant's icon actions (`?screen=ghost`, #392), in tab order, and
 * a native button that shows whether the host's reset reached buttons.
 */
function GhostGate() {
  const dots = 'M5 12h.01M12 12h.01M19 12h.01';
  return (
    <main className="gate-main">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" aria-label="Ghost button">
          <Icon path={dots} />
        </Button>
        <LinkButton
          variant="ghost"
          size="icon"
          href="/list"
          aria-label="Ghost link"
        >
          <Icon path="M9 18l6-6-6-6" />
        </LinkButton>
        <ActionButton variant="ghost" shape="round-sm" label="Ghost action">
          <Icon path={dots} />
        </ActionButton>
        <HeaderMenu
          icon="more"
          variant="ghost"
          label="Ghost menu"
          items={[{ label: 'Rename', onSelect: () => {} }]}
        />
        <button type="button" id="native-button">
          Native
        </button>
      </div>
    </main>
  );
}

/**
 * The README's views as links (`?screen=tabs`) beside a link to a task: the
 * task's screen is over a view, so neither view's link is current there.
 */
function TabsGate() {
  const nav = useNav(places);
  return (
    <main className="gate-main">
      <ViewTabs nav={nav} />
      <p className="mt-4">
        <a
          {...nav.link({
            kind: 'task',
            subject: location.origin + '/alice/tasks/1',
          })}
        >
          Open a task
        </a>
      </p>
      <p className="mt-4" id="tabs-place">
        {nav.place.kind}
      </p>
    </main>
  );
}

function SearchGate() {
  const [text, setText] = useState('');
  const [found, setFound] = useState<SearchState>({ items: [] });
  // What a choice, Enter or a close request did, for the checks to read.
  const [opened, setOpened] = useState<readonly string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    Object.assign(window, { searchGate: setFound });
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== 'k') return;
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  const items = useMemo(() => withMedia(found.items), [found.items]);
  const query = text.trim();
  // An address bar searches neither an address nor a single character.
  const suggest = !addressBar || (!URL.canParse(query) && query.length >= 2);
  const field = (
    <SuggestField
      ref={input}
      label={language === 'de' ? 'Adresse oder Suche' : 'Address or search'}
      labelHidden
      placeholder={
        language === 'de'
          ? 'Suchen oder Adresse eingeben'
          : 'Search or enter an address'
      }
      value={text}
      onChange={setText}
      items={query ? items : []}
      loading={found.loading}
      failed={found.failed}
      notice={found.notice}
      suggest={suggest}
      onSelect={(item) => setOpened((o) => [...o, 'select ' + item.id])}
      onSubmit={(value) => setOpened((o) => [...o, 'submit ' + value])}
    />
  );
  return (
    <main className="gate-main">
      <h1 className="mb-4 text-lg font-semibold">Explorer</h1>
      {addressBar ? (
        <WorkspacePanel
          title="Find"
          open
          onRequestClose={() => setOpened((o) => [...o, 'close'])}
        >
          {field}
        </WorkspacePanel>
      ) : (
        field
      )}
      <ol aria-label="Opened" className="mt-4">
        {opened.map((entry, i) => (
          <li key={i}>{entry}</li>
        ))}
      </ol>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
