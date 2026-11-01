# @sempods/app-ui

UI components for sempods apps built with React and Tailwind CSS 4:
[shadcn/ui](https://ui.shadcn.com) components (style `aria-nova`) on
[React Aria Components](https://react-spectrum.adobe.com/react-aria/), a few
adapters that work with the SDK's editors and confirmations, and a theme token
contract. The package is versioned and released together with
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
heading, in English and German. The app's router supplies `subject` (the task
in the address) and `leave`, which removes it from the address. The UI gate
runs this file as written, as the reference screen's task dialog:

```tsx
// task-dialog.tsx
import { useEffect } from 'react';
import {
  ResourceEditor,
  useAppState,
  useContextEditor,
  useMessages,
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
  leave,
}: {
  readonly subject: string | null;
  readonly context: string;
  readonly leave: () => void;
}) {
  const t = useMessages(texts);
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
  // An editor still showing another subject is not this dialog's.
  const editor =
    subject && edit.target?.subject === subject ? edit.editor : null;
  // The SDK asks before a dirty draft is discarded.
  const requestClose = async () => {
    if (await edit.close()) leave();
  };
  return (
    <ScreenDialog
      title={t.details}
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

## What is checked

The packed browser gate builds a reference screen with Vite and Tailwind 4
against the installed packages and runs in Chromium and WebKit, and in
Firefox on the Linux CI runner. It checks Escape in fields, in SDK
confirmations, on Close, in menus and in the date chooser; focus trap and
restore; Save after cancelled closes; closing right after opening; resizing
with a draft; Back and Forward with a dirty draft; the calendar-date roundtrip
in three time zones; keyboard use of menus and the calendar; 44px targets; the
cascade with the SDK's styles; and the rendered contrast of both palettes and
all variants in light and dark mode. It uses a loopback fixture Pod: it is not
evidence from a real Pod, an installed PWA, iOS or a human test.

## Limits

- The SDK's buttons do not follow the `inverted`, `outline` and `text`
  variants (see the bridge).
- Contrast is measured for the states the gate reaches, not for every state an
  app can create; an app's own theme needs its own check.
- The UI layer adds about 97 KB of gzipped JavaScript to an app (measured in
  the spike with the same components).

Code is licensed under Apache-2.0, documentation under CC BY 4.0; the shadcn/ui
components are adapted under MIT (see [NOTICE](NOTICE) and
[provenance](PROVENANCE.md)).
