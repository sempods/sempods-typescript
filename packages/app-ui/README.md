# @sempods/app-ui

UI components for sempods apps built with React and Tailwind CSS 4:
[shadcn/ui](https://ui.shadcn.com) components (style `aria-nova`) on
[React Aria Components](https://react-spectrum.adobe.com/react-aria/), a few
adapters that work with the SDK's editors and confirmations, a router over the
app's own address model, and a theme token contract. The package is versioned and released together with
`@sempods/app-sdk`, so fixes reach an app through a dependency update instead
of being copied into it.

The app keeps its own `theme.css` (colours), its screens and its copy. The
package does not wrap the whole React Aria API: anything it does not export,
the app takes from `react-aria-components` directly.

## Install

```sh
npm install @sempods/app-ui @sempods/app-sdk @sempods/client-sdk react react-dom
npm install --save-dev tailwindcss @tailwindcss/vite
```

Peers: React 19, `@sempods/app-sdk` of the same minor version as this package,
and Tailwind CSS 4.1 or newer (checked with 4.3.3). The package ships built
JavaScript with TypeScript declarations; `react-aria-components`,
`@internationalized/date`, `lucide-react` and the class utilities are its own
dependencies. The `shadcn` CLI is not needed at runtime.

## Set up Tailwind

Add the Tailwind plugin to Vite:

```ts
// vite.config.ts
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [react(), tailwindcss()] });
```

The app's stylesheet declares the cascade layers first, then imports Tailwind,
the package and the app's theme:

```css
/* src/index.css */
@layer theme, base, sempods, components, utilities;
@import 'tailwindcss';
@import '@sempods/app-ui/styles.css';
@import './theme.css';
```

That is all. `styles.css` registers the package's built JavaScript as a Tailwind
source, so the app needs no `@source` line and no Vite `optimizeDeps` hint. The
layer statement puts the SDK's own styles (layer `sempods`) above Tailwind's
reset and below the utilities: package components keep their look inside SDK
surfaces such as the `ResourceEditor`, and the SDK's confirmations stay
centred. The SDK's
[cascade layer guide](https://github.com/sempods/sempods-typescript/blob/v0.6.0/docs/react-authoring.md#cascade-layer-order)
explains the order and which app rules still override SDK rules.

`styles.css` adds:

- the palette roles as Tailwind colours (`bg-primary`, `text-muted-foreground`,
  `border-input`, `bg-action`, …) and the radius scale;
- default role values (a calm neutral palette) in the `theme` layer without
  specificity, so any `:root` rule of the app wins;
- the component variants and the bridge to the SDK tokens (below);
- shadcn's state variants (`data-open:`, `data-disabled:`, …) and the
  `tw-animate-css` animations of popovers and menus;
- in `base`: borders without a colour class take the `border` role, the body
  takes `background` and `foreground`, and app links, buttons and fields get a
  solid focus outline;
- in its own layer `app-ui-focus`, after Tailwind's utilities: a solid 2px
  focus outline in the `ring` colour on the package's components and calendar
  days. Name the layer in the order statement only to move it; an unlayered
  app rule overrides it;
- in the layer `app-ui-motion`: without entry and exit animations of popovers,
  menus and selects when the person asks for reduced motion
  (`prefers-reduced-motion: reduce`); other animations, such as a spinner,
  keep running.

## The theme contract

A theme changes only palette roles. Write them on `:root` in `light-dark()` so
they follow the system's light or dark mode:

```css
/* src/theme.css */
:root {
  --background: light-dark(#ffffff, #0e171d);
  --foreground: light-dark(#11293a, #e1edf3);
  --primary: light-dark(#0a6680, #5ec6e4);
  --primary-foreground: light-dark(#ffffff, #06212b);
  --ring: light-dark(#0a6680, #5ec6e4);
}
```

| Role                                | Use                                                           |
| ----------------------------------- | ------------------------------------------------------------- |
| `background`, `foreground`          | Page and its text                                             |
| `card`, `popover` (`-foreground`)   | Surfaces of cards, dialogs, menus and popovers                |
| `primary`, `primary-foreground`     | The main action and selected days                             |
| `secondary`, `secondary-foreground` | Tonal secondary actions                                       |
| `muted`, `muted-foreground`         | A quiet surface, and secondary text                           |
| `accent`, `accent-foreground`       | The highlight of focused menu items                           |
| `destructive`                       | Destructive actions                                           |
| `border`                            | Decorative separators                                         |
| `input`                             | Boundaries of fields and outlined controls; keep 3:1          |
| `ring`                              | The focus outline; keep 3:1                                   |
| `radius`                            | Corner radius; the scale `rounded-sm` … `rounded-4xl` follows |

Text pairs need 4.5:1, icons, field boundaries and focus 3:1, in both modes.

**Component variants** switch with attributes on `<html>` and map controls to
roles, never to colour values, so a checked palette stays checked:

| Attribute        | Values                               | Effect on `ActionButton` and `Button`                                                  |
| ---------------- | ------------------------------------ | -------------------------------------------------------------------------------------- |
| `data-actions`   | `solid` (default), `inverted`        | `inverted`: the primary action takes the page colour with a primary outline and text   |
| `data-secondary` | `tonal` (default), `outline`, `text` | Secondary actions on a tonal surface, outlined in `input`, or as primary-coloured text |

**The SDK bridge** passes the roles to the SDK's `--sempods-*` tokens, so
`AppAccess`, editors, notices and confirmations follow the theme:

| SDK token                                        | Role                            |
| ------------------------------------------------ | ------------------------------- |
| `--sempods-bg`, `--sempods-text`                 | `background`, `foreground`      |
| `--sempods-muted`                                | `muted-foreground`              |
| `--sempods-line`, `--sempods-field-line`         | `border`, `input`               |
| `--sempods-accent`, `--sempods-on-accent`        | `primary`, `primary-foreground` |
| `--sempods-primary-bg`, `--sempods-primary-text` | `primary`, `primary-foreground` |
| `--sempods-secondary-text`                       | `primary`                       |
| `--sempods-focus`                                | `ring`                          |
| `--sempods-font`, `--sempods-radius`             | `--font-sans`, `radius`         |

The SDK's buttons have no outline or tonal surface, so they keep their own
look under `inverted`, `outline` and `text`: Save and Confirm stay filled in
`primary`, the SDK's other actions stay primary-coloured text.

Tailwind's `dark:` variant follows the system setting, as `light-dark()` does
with `color-scheme: light dark`. An app that forces one scheme sets
`color-scheme` on `:root` and redefines `@custom-variant dark` to match.

## Components

The shadcn/ui components keep shadcn's names and React Aria's props
(`onPress`, `isDisabled`, `isOpen`, …): `Button`, `LinkButton`, `Calendar`,
`RangeCalendar`, `Dialog` and its parts, `DropdownMenu` and its parts,
`Input`, `InputGroup` and its parts, `Popover` and its parts, `Select` and its
parts, and `Textarea`. shadcn's
[aria-nova documentation](https://ui.shadcn.com/docs/components) describes
them. The adapters below are the sempods compositions; prefer them for screens,
menus, dates and actions.

A component the package lacks can be added with `shadcn add` (the CLI as a
development dependency). A component copied out of the package to change it
becomes the app's own: package updates no longer reach it, so do that on
purpose.

## Adapters

A routed task dialog with an SDK editor, a date field and a menu in its
heading, in English and German. The [router](#router) supplies `subject` (the
task in the address), `context` (the source Context the address names) and
`leave`, which closes the address. A source the app cannot read is an explicit
error, never replaced by another Context. The UI gate runs this file as
written, as the reference screen's task dialog:

```tsx
// task-dialog.tsx
import { useEffect, type ReactNode } from 'react';
import {
  ResourceEditor,
  useAppState,
  useContextEditor,
  useMessages,
  useSdkLocale,
} from '@sempods/app-sdk/react';
import { date, fields, flag, text } from '@sempods/client-sdk/edit';
import {
  DateChooser,
  HeaderMenu,
  Input,
  ScreenDialog,
  Textarea,
} from '@sempods/app-ui';

const schema = 'https://schema.org/';
export const taskFields = fields(
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
    // A calendar day; an existing zoned xsd:dateTime stays as it is.
    planned: date(schema + 'startDate', { optional: true, orDateTime: true }),
  },
  { type: schema + 'Action' },
);

const texts = {
  en: {
    details: 'Details',
    taskMenu: 'Task menu',
    print: 'Print',
    title: 'Title',
    description: 'Description',
    planned: 'Start considering',
  },
  de: {
    details: 'Details',
    taskMenu: 'Aufgabenmenü',
    print: 'Drucken',
    title: 'Titel',
    description: 'Beschreibung',
    planned: 'Vormerken ab',
  },
};

export function TaskDialog({
  subject,
  context,
  title,
  leave,
}: {
  readonly subject: string | null;
  readonly context: string;
  /** Another heading, for an action address of the task. */
  readonly title?: ReactNode;
  readonly leave: () => void;
}) {
  const t = useMessages(texts);
  const { messages } = useSdkLocale();
  const edit = useContextEditor(taskFields);
  const { open, close } = edit;
  // While the SDK changes the target (`changing`), it opens no editor; the
  // effect runs again once the change has settled.
  const { changing } = useAppState();
  useEffect(() => {
    if (changing) return;
    if (subject) void open({ subject, context });
    else void close();
  }, [subject, context, changing, open, close]);
  // An editor still showing another target is not this dialog's.
  const editor =
    subject &&
    edit.target?.subject === subject &&
    edit.target.context === context
      ? edit.editor
      : null;
  // The SDK asks before a dirty draft is discarded.
  const requestClose = async () => {
    if (await edit.close()) leave();
  };
  return (
    <ScreenDialog
      title={title ?? t.details}
      open={subject !== null}
      onRequestClose={() => void requestClose()}
      actions={
        <HeaderMenu
          icon="more"
          label={t.taskMenu}
          items={[{ label: t.print, onSelect: () => window.print() }]}
        />
      }
    >
      {edit.phase === 'unavailable' && edit.problem ? (
        // A source Context the app cannot read: no editor, no other Context.
        <p role="alert">{messages.contextProblems?.[edit.problem]}</p>
      ) : (
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
          {(draft, change) => (
            <div className="grid gap-5">
              <label className="grid gap-1.5">
                {t.title}
                <Input
                  value={draft.title}
                  onChange={(e) => change({ ...draft, title: e.target.value })}
                  required
                />
              </label>
              <label className="grid gap-1.5">
                {t.description}
                <Textarea
                  rows={2}
                  value={draft.description ?? ''}
                  onChange={(e) =>
                    change({ ...draft, description: e.target.value })
                  }
                />
              </label>
              <DateChooser
                label={t.planned}
                value={draft.planned}
                onChange={(planned) => change({ ...draft, planned })}
                optional
              />
            </div>
          )}
        </ResourceEditor>
      )}
    </ScreenDialog>
  );
}
```

An app's own main action uses `ActionButton`, for example a 72px round button
with an icon: `<ActionButton shape="round-lg" label="Complete" onPress={complete}>`.

- **`ScreenDialog`**: a routed screen as a modal, full screen below 640px and up
  to 42rem wide above, with a heading, optional `actions` and Close. It is
  controlled: Escape, Close and a press beside it call `onRequestClose`, and
  it closes only when `open` turns false, so it follows the route. A press in
  an SDK confirmation (a native `<dialog>`) does not count as a press beside
  it. It has no entry or exit animation, because WebKit kept a modal mounted
  that closed during one: it goes as soon as it closes. Close takes the SDK's "Close" text unless `closeLabel` is
  given.
- **`HeaderMenu`**: a round 44px icon button (`icon="menu"` or `"more"`) with a
  menu of actions, separators (`null`) and submenus of checked choices
  (`{ label, choices: [{ label, checked, onSelect }] }`; give choices an `id`
  when their labels can repeat). Arrow keys move,
  ArrowRight opens a submenu, ArrowLeft and Escape close one level, focus
  returns to the button.
- **`DateChooser`**: the calendar-date chooser for the SDK's `date` field. It
  takes the field's draft value (`2026-10-29`, with `orDateTime` also a zoned
  date-time, or `null`) and returns a day as `YYYY-MM-DD`, or `null` with
  "Remove date" when `optional`. Days are React Aria `CalendarDate` values
  without time or zone, so the stored day does not depend on the device's time
  zone. A choice takes effect only with Apply; Escape or a press beside it keeps
  the draft. A stored date-time is shown in the SDK provider's time zone; the
  chooser starts at the day of its stored offset and replaces it only when a
  day is applied. Month names and the first weekday follow the SDK provider's
  locale; days and month buttons are 44px targets. Apply and Remove date stay
  in a bar at the chooser's bottom edge, visible on a phone as it opens.
- **`ActionButton`**: an app's own action in the theme's variants: `variant`
  `primary` (default), `secondary`, `ghost` or `destructive`; `shape` `pill`
  (56px high), `round` (56px) or `round-lg` (72px); `label` names an icon-only
  button.

The adapters' texts ("Menu", "No date", "Apply", "Remove date") follow the
SDK provider's language (English or German) and can be passed as props.

## Router

`useNav(model)` routes an app over its own address model: the app says which
places it has and how they map to addresses, the router moves through the
browser history. Every switch, Back and Forward runs through the SDK's
`navigate`, so an unsaved edit asks first; staying keeps the address, the
screen, the draft and the history.

- **`AddressModel<P>`**: `parse(pathname, search)` returns `{ place, canonical }`,
  `format(place)` the address of a place (path and query, starting with the
  app's path). An address in another form that the app knows, such as a legacy
  link, names its canonical form, which replaces it in place. An unknown or
  invalid address names itself, so its explicit page keeps the address the
  person followed. The callback keeps its address: the runtime reads its
  parameters.
- **`useNav(model)`** returns the shown `place` and:
  - `go(place, { replace })`: a new history entry, or in place;
  - `close(fallback)`: back to the in-app place that opened the screen (kept
    in `history.state`), or after a direct entry to `fallback` in place;
  - `link(place)`: `href` and `onClick` for an `<a>`; a plain click switches
    in place, Ctrl/Cmd-, Shift- and middle clicks open the address in the
    browser as usual.
- **`replaceUrl`**: pass it to `createBrowserRuntime`, so the address the
  runtime returns to after sign-in is the one the app shows.

Call `useNav` once, in the app's frame inside `SempodsProvider`, and pass
`nav` down. While the SDK asks about a Back or Forward, further history moves
start no second question; the answer applies to where the browser is when it
comes. Leaving the document (Back past its first entry, reload, closing the
tab) is not a router move: the SDK's `beforeunload` prompt covers it.

An address model with a resource route (`tasks/<id>`), its action route
(`tasks/<id>/postpone`), a literal route for the menu (`list`), a creation
route that wins over the resource pattern, the source Context in the query,
a legacy link and explicit not-found places. The UI gate runs this file as
written, as the reference screen's addresses:

```ts
// places.ts
import type { AddressModel } from '@sempods/app-ui';

/** The app's path on the site (Vite's `base`), with a trailing slash. */
const base = import.meta.env.BASE_URL;

export type Place =
  | { readonly kind: 'zen' }
  | { readonly kind: 'list' }
  | { readonly kind: 'new' }
  /** `context`: the source Context the address names; never substituted. */
  | {
      readonly kind: 'task';
      readonly subject: string;
      readonly context?: string;
      readonly action?: 'postpone';
    }
  | { readonly kind: 'callback' }
  | { readonly kind: 'not-found'; readonly reason: 'unknown' | 'invalid' };

const absolute = (value: string) => /^https?:\/\/\S+$/.test(value);

/** A subject IRI as one path segment: UTF-8 in base64url. */
const encode = (iri: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(iri)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
function decode(id: string): string | null {
  if (!/^[\w-]+$/.test(id)) return null;
  try {
    const binary = atob(id.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const iri = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return absolute(iri) ? iri : null;
  } catch {
    return null;
  }
}

export const places: AddressModel<Place> = {
  format(place) {
    switch (place.kind) {
      case 'zen':
      case 'not-found':
        return base;
      case 'list':
        return base + 'list';
      case 'new':
        return base + 'tasks/add';
      case 'callback':
        return base + 'callback';
      case 'task': {
        const action = place.action ? '/' + place.action : '';
        const path = `${base}tasks/${encode(place.subject)}${action}`;
        return place.context
          ? `${path}?context=${encodeURIComponent(place.context)}`
          : path;
      }
    }
  },
  parse(pathname, search) {
    const here = pathname + search;
    const known = (place: Place) => ({
      place,
      canonical: places.format(place),
    });
    const missing = (reason: 'unknown' | 'invalid') => ({
      place: { kind: 'not-found', reason } as const,
      canonical: here,
    });
    if (!(pathname + '/').startsWith(base)) return missing('unknown');
    const path = pathname.slice(base.length).replace(/\/$/, '');
    // The runtime reads the callback's parameters: it keeps its address.
    if (path === 'callback')
      return { place: { kind: 'callback' }, canonical: here };
    const query = new URLSearchParams(search);
    const context = query.get('context');
    if (context !== null && !absolute(context)) return missing('invalid');
    const task = (id: string, action?: 'postpone') => {
      const subject = decode(id);
      if (!subject) return missing('invalid');
      return known({
        kind: 'task',
        subject,
        ...(context ? { context } : {}),
        ...(action ? { action } : {}),
      });
    };
    // A legacy link to a task becomes its canonical address.
    const legacy = query.get('task');
    if (path === '' && legacy !== null) return task(legacy);
    if (path === '') return known({ kind: 'zen' });
    if (path === 'list') return known({ kind: 'list' });
    // Literal routes win over the resource pattern sharing their prefix.
    if (path === 'tasks/add' || path === 'tasks/new')
      return known({ kind: 'new' });
    const match = /^tasks\/([^/]+)(?:\/(postpone))?$/.exec(path);
    if (match?.[1]) return task(match[1], match[2] ? 'postpone' : undefined);
    return missing(path.startsWith('tasks/') ? 'invalid' : 'unknown');
  },
};
```

The frame: the menu switches the literal route, a list links to the resource
route, a button opens the action route, the task dialog follows the address
and edits the Context it names, and not-found places get an explicit page once
the person is connected (a modal before that would block sign-in):

```tsx
// app.tsx
import { createBrowserRuntime } from '@sempods/app-sdk';
import {
  AppAccess,
  LoadNotice,
  SempodsProvider,
  TargetScreen,
  useAppState,
  useList,
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

const base = import.meta.env.BASE_URL;
const runtime = createBrowserRuntime({
  identity: {
    kind: 'dynamic',
    name: 'Focus',
    redirectUri: location.origin + base + 'callback',
  },
  // Sign-in returns to the address it started from, a task link included,
  // but never to the callback or outside the app.
  returnTo: () => {
    const address = location.pathname + location.search;
    return address.startsWith(base) && !address.startsWith(base + 'callback')
      ? address
      : base;
  },
  replaceUrl,
});

export function App() {
  return (
    <SempodsProvider runtime={runtime}>
      <Frame />
    </SempodsProvider>
  );
}

function Frame() {
  const nav = useNav(places);
  const { connections } = useAppState();
  const list = nav.place.kind === 'list';
  return (
    <main>
      {connections.length > 0 && (
        <HeaderMenu
          label="Menu"
          items={[
            {
              label: 'View',
              choices: [
                {
                  label: 'Zen',
                  checked: !list,
                  onSelect: () => nav.go({ kind: 'zen' }),
                },
                {
                  label: 'List',
                  checked: list,
                  onSelect: () => nav.go({ kind: 'list' }),
                },
              ],
            },
          ]}
        />
      )}
      <AppAccess appName="Focus" />
      <TargetScreen>
        <Tasks nav={nav} />
      </TargetScreen>
      {nav.place.kind === 'not-found' && connections.length > 0 && (
        <ScreenDialog
          title="Not found"
          open
          onRequestClose={() => nav.go({ kind: 'zen' }, { replace: true })}
        >
          <p>
            {nav.place.reason === 'invalid'
              ? 'This task link is not valid.'
              : 'This address does not lead anywhere in Focus.'}
          </p>
        </ScreenDialog>
      )}
    </main>
  );
}

function Tasks({ nav }: { readonly nav: Nav<Place> }) {
  const list = useList(taskFields);
  const { view } = useAppState();
  if (!view) return null;
  const { place } = nav;
  // A link names the Context the list reads, so the address keeps its source.
  const task = (subject: string, action?: 'postpone'): Place => ({
    kind: 'task',
    subject,
    context: view.contextIri,
    ...(action ? { action } : {}),
  });
  return (
    <>
      <LoadNotice {...list} />
      <ul>
        {list.data?.items.map((item) => (
          <li key={item.iri}>
            <a {...nav.link(task(item.iri))}>{item.data.title}</a>
            <ActionButton
              variant="secondary"
              onPress={() => nav.go(task(item.iri, 'postpone'))}
            >
              Not today
            </ActionButton>
          </li>
        ))}
      </ul>
      <TaskDialog
        subject={place.kind === 'task' ? place.subject : null}
        // The Context the address names; only an address without one uses
        // the selected Context.
        context={(place.kind === 'task' && place.context) || view.contextIri}
        title={
          place.kind === 'task' && place.action === 'postpone'
            ? 'Not today'
            : undefined
        }
        leave={() => {
          nav.close({ kind: 'zen' });
          void list.reload();
        }}
      />
    </>
  );
}
```

Which Context a link names: a link from a list names the Context the list
reads; a link derived from a task screen, such as "next task" or an action
of the same task, names the source the current address names
(`place.context`), not the selected Context, which may be another one. An
address without a source edits the selected Context. A named source the app
cannot read shows `useContextEditor`'s `unavailable` problem in the dialog,
as above, and opens no editor in another Context.

Host rules for the app's addresses (a rewrite to `index.html` for each
resource pattern), the offline navigation allowlist and the bounded sign-in
return come from the app template's tooling, not from this package.

## What is checked

The packed browser gate builds a reference screen with Vite and Tailwind 4
against the installed packages and runs in Chromium and WebKit, and in
Firefox on the Linux CI runner. It checks Escape in fields, in SDK
confirmations, on Close, in menus and in the date chooser; focus trap and
restore; Save after cancelled closes; closing right after opening; resizing
with a draft; Back and Forward with a dirty draft; the calendar-date roundtrip
in three time zones; keyboard use of menus and the calendar; 44px targets; the
cascade with the SDK's styles; the rendered contrast of both palettes and
all variants in light and dark mode; and the router's 29-check matrix of
links, direct and signed-out entry, Close, Back and Forward with a dirty
draft, history moves while the SDK asks, reload, legacy links and the source
Context. It uses a loopback fixture Pod: it is not
evidence from a real Pod, an installed PWA, iOS or a human test.

## Limits

- The SDK's buttons do not follow the `inverted`, `outline` and `text`
  variants (see the bridge).
- Contrast is measured for the states the gate reaches, not for every state an
  app can create; an app's own theme needs its own check.
- The router does not protect leaving the document: Back past its first
  entry, a reload or closing the tab is the SDK's `beforeunload` prompt.
- The UI layer adds about 97 KB of gzipped JavaScript to an app (measured in
  the spike with the same components).

Code is licensed under Apache-2.0, documentation under CC BY 4.0; the shadcn/ui
components are adapted under MIT (see [NOTICE](NOTICE) and
[provenance](PROVENANCE.md)).
