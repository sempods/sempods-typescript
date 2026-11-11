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

Peers: React 19, `@sempods/app-sdk` and `@sempods/client-sdk` of the same minor
version as this package, and Tailwind CSS 4.1 or newer (checked with 4.3.3).
The package ships built JavaScript with TypeScript declarations;
`react-aria-components`, `@internationalized/date`, `lucide-react` and the
class utilities are its own dependencies. The `shadcn` CLI is not needed at
runtime.

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
[cascade layer guide](https://github.com/sempods/sempods-typescript/blob/v0.8.0-dev.1/docs/react-authoring.md#cascade-layer-order)
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
  days. Menu triggers and menu rows show it only for keyboard focus, as
  React Aria's `data-focus-visible` reports it, and a row draws it inside its
  edge; with forced colors, the focused row draws it for pointer focus too.
  Name the layer in the order statement only to move it; an unlayered
  app rule overrides it;
- in the layer `app-ui-motion`: without entry and exit animations of popovers,
  menus and selects when the person asks for reduced motion
  (`prefers-reduced-motion: reduce`); other animations, such as a spinner,
  keep running.

## The theme contract

The look is built in layers, and each layer reads only the one before it:

1. **Palette roles** (`--primary`, `--background`, …): colour values, written
   by the app's `theme.css`.
2. **Component roles** (`--action*`, `--action-secondary*`): the two action
   roles with a surface, text and border each. The variants below point them
   at palette roles.
3. **The SDK bridge**: `styles.css` passes roles to the SDK's `--sempods-*`
   tokens, so SDK surfaces follow both layers above.

Change the look in the first two layers only: palette roles in `theme.css`,
variants on `<html>`, or, for an action look no variant gives, all three parts
of both action roles. Leave the bridge, the `--sempods-*` tokens and the
components' classes alone; then the package's buttons and the SDK's actions
stay alike.

A theme writes palette roles on `:root` in `light-dark()` so they follow the
system's light or dark mode:

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
| `accent`, `accent-foreground`       | The highlight of hovered and focused menu items               |
| `destructive`                       | Destructive actions                                           |
| `border`                            | Decorative separators                                         |
| `input`                             | Boundaries of fields and outlined controls; keep 3:1          |
| `ring`                              | The focus outline; keep 3:1                                   |
| `radius`                            | Corner radius; the scale `rounded-sm` … `rounded-4xl` follows |

Text pairs need 4.5:1, icons, field boundaries and focus 3:1, in both modes.

**Component variants** switch with attributes on `<html>` and point the action
roles at palette roles, never at colour values, so a checked palette stays
checked:

| Attribute        | Values                               | Effect on `ActionButton`, `Button` and SDK actions                                     |
| ---------------- | ------------------------------------ | -------------------------------------------------------------------------------------- |
| `data-actions`   | `solid` (default), `inverted`        | `inverted`: the primary action takes the page colour with a primary outline and text   |
| `data-secondary` | `tonal` (default), `outline`, `text` | Secondary actions on a tonal surface, outlined in `input`, or as primary-coloured text |

### Check an app theme

Load the app stylesheet in a browser. In the browser runner, emulate light
and dark in turn and call this function in the page for each preference.
This works for native `light-dark()` and for builds that compile it into media
queries. The development entry ships separately from the component entry.

```ts
// check-theme.ts
import { checkTheme, formatThemeReport } from '@sempods/app-ui/theme-check';

export function checkPreferredTheme() {
  const report = checkTheme();
  if (report.failures.length) throw new Error(formatThemeReport(report));
  return report;
}
```

Each call samples the browser’s current colour preference. Read `report.skipped`
for the other preference and for schemes the root palette excludes. An explicit
`checkTheme('dark')` under a light preference returns only skips. A failure gives
the active variant flag, component and palette roles, painted colours, ratio
and threshold. Change a role in `adjust`, then rerun to check the other
pairs listed in `alsoReads`. A component colour that differs from the
variant mapping is marked as an override. The report is JSON-serializable.
The original active attributes are also sampled when an implicit default paints
differently from an explicit variant. For offline evaluation, `readTheme()` captures resolved sRGB samples,
including the browser's mixtures. Pass its `samples`, `active` and `skipped`
to `evaluateTheme()` to replay the same check without a DOM.

The table lists CSS roles without their leading dashes. Each translucent
surface is composited over the listed backdrop. Hover surfaces are resolved
from the action roles in the current variant. The dark destructive action
uses a lighter red to keep its text above 4.5:1 over its 30% hover tint on
the page, a card or a popover.

<!-- theme-pairs -->

| Variant  | Foreground                  | Surface                | Backdrop                  | State | Minimum ratio |
| -------- | --------------------------- | ---------------------- | ------------------------- | ----- | ------------- |
| all      | foreground                  | background             | background                | rest  | 4.5           |
| all      | card-foreground             | card                   | background                | rest  | 4.5           |
| all      | popover-foreground          | popover                | background                | rest  | 4.5           |
| all      | accent-foreground           | accent                 | background                | rest  | 4.5           |
| all      | muted-foreground            | background             | background                | rest  | 4.5           |
| all      | muted-foreground            | muted                  | background                | rest  | 4.5           |
| all      | muted-foreground            | card                   | background                | rest  | 4.5           |
| all      | muted-foreground            | popover                | background                | rest  | 4.5           |
| all      | primary-foreground          | primary                | background                | rest  | 4.5           |
| all      | destructive                 | destructive-tint       | background, card, popover | rest  | 4.5           |
| all      | destructive                 | destructive-hover      | background, card, popover | hover | 4.5           |
| all      | input                       | background             | background                | rest  | 3             |
| all      | input                       | card                   | background                | rest  | 3             |
| all      | input                       | popover                | background                | rest  | 3             |
| all      | ring                        | background             | background                | rest  | 3             |
| all      | ring                        | card                   | background                | rest  | 3             |
| all      | ring                        | popover                | background                | rest  | 3             |
| solid    | action-foreground           | action                 | background                | rest  | 4.5           |
| solid    | action-foreground           | action-hover           | background                | hover | 4.5           |
| inverted | action-foreground           | action                 | background                | rest  | 4.5           |
| inverted | action-foreground           | action-hover           | background                | hover | 4.5           |
| tonal    | action-secondary-foreground | action-secondary       | background                | rest  | 4.5           |
| tonal    | action-secondary-foreground | action-secondary-hover | background                | hover | 4.5           |
| outline  | action-secondary-foreground | action-secondary       | background, card, popover | rest  | 4.5           |
| outline  | action-secondary-foreground | action-secondary-hover | background, card, popover | hover | 4.5           |
| outline  | action-secondary-border     | transparent            | background, card, popover | rest  | 3             |
| text     | action-secondary-foreground | action-secondary       | background, card, popover | rest  | 4.5           |
| text     | action-secondary-foreground | action-secondary-hover | background, card, popover | hover | 4.5           |

<!-- /theme-pairs -->

States derive from the parts: hover mixes 12% of the text into a primary
action's surface and 8% into a secondary action's, in `oklch`. A theme that
sets the action roles directly instead of using a variant sets all six:

| Component role                                                                     | Default                                            |
| ---------------------------------------------------------------------------------- | -------------------------------------------------- |
| `--action`, `--action-foreground`, `--action-border`                               | `primary`, `primary-foreground`, `primary`         |
| `--action-secondary`, `--action-secondary-foreground`, `--action-secondary-border` | `secondary`, `secondary-foreground`, `transparent` |

**The SDK bridge** passes the roles to the SDK's `--sempods-*` tokens, so
`AppAccess`, editors, notices and confirmations follow the theme and the
variants. Apps do not set these tokens themselves:

| SDK token                                                                          | Role                                                                               |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `--sempods-bg`, `--sempods-text`                                                   | `background`, `foreground`                                                         |
| `--sempods-muted`                                                                  | `muted-foreground`                                                                 |
| `--sempods-line`, `--sempods-field-line`                                           | `border`, `input`                                                                  |
| `--sempods-accent`, `--sempods-on-accent`                                          | `primary`, `primary-foreground`                                                    |
| `--sempods-primary-bg`, `--sempods-primary-text`, `--sempods-primary-border`       | `--action`, `--action-foreground`, `--action-border`                               |
| `--sempods-secondary-bg`, `--sempods-secondary-text`, `--sempods-secondary-border` | `--action-secondary`, `--action-secondary-foreground`, `--action-secondary-border` |
| `--sempods-focus`                                                                  | `ring`                                                                             |
| `--sempods-font`, `--sempods-radius`                                               | `--font-sans`, `radius`                                                            |

The package's browser gate checks that SDK actions match the package's buttons
of the same role at rest and on hover across all six combinations, with both
package palettes in light and dark.

Tailwind's `dark:` variant follows the system setting, as `light-dark()` does
with `color-scheme: light dark`. An app that forces one scheme sets
`color-scheme` on `:root` and redefines `@custom-variant dark` to match.

## Standards

The package builds on web and community standards: CSS custom properties,
cascade layers, `light-dark()` and `color-mix()` from CSS Color 5, Tailwind CSS
4's `@theme`, shadcn/ui's role names, React Aria's keyboard and screen reader
behaviour after the WAI-ARIA Authoring Practices, and the contrast criteria of
WCAG 2.2. The layers follow the token tiers of the
[Design Tokens Community Group](https://www.designtokens.org/) as a concept, not
its file format.

Its own parts are the action roles (`--action*`), the variant attributes
`data-actions` and `data-secondary`, and the bridge to the SDK's tokens.
They are the contract above: change them only together with this README and
the browser gate.

## Components

The shadcn/ui components keep shadcn's names and React Aria's props
(`onPress`, `isDisabled`, `isOpen`, …): `Badge`, `Button`, `LinkButton`,
`Calendar`, `RangeCalendar`, `Dialog` and its parts, `DropdownMenu` and its
parts, `Input`, `InputGroup` and its parts, `Popover` and its parts, `Select`
and its parts, `Textarea`, `Toggle`, and `ToggleGroup` with
`ToggleGroupItem`. `Badge` suits read-only tags. shadcn's
[aria-nova documentation](https://ui.shadcn.com/docs/components) describes
them. The adapters below are the sempods compositions; prefer them for screens,
menus, dates and actions.

The compact `Dialog` names its close buttons (the corner one and
`DialogFooter`'s `showCloseButton`) with the SDK's "Close" text in the
provider's language, or English without a provider; `closeLabel` replaces it.
A press in an SDK confirmation (a native modal `<dialog>`) never counts as a
press beside it, also with the app's own `shouldCloseOnInteractOutside`, so
cancelling the question keeps the dialog and the draft. Around an SDK editor,
route every close request through the editor, as the UI gate's quick edit
does:

```tsx
// quick-edit.tsx
import { useEffect } from 'react';
import {
  ResourceEditor,
  useAppState,
  useContextEditor,
  useMessages,
  useSdkLocale,
} from '@sempods/app-sdk/react';
import { Dialog, DialogHeader, DialogTitle, Input } from '@sempods/app-ui';
import { taskFields } from './task-dialog';

const texts = {
  en: { rename: 'Rename', title: 'Title' },
  de: { rename: 'Umbenennen', title: 'Titel' },
};

export function QuickEdit({
  subject,
  context,
  leave,
}: {
  readonly subject: string | null;
  readonly context: string;
  readonly leave: () => void;
}) {
  const t = useMessages(texts);
  const { messages } = useSdkLocale();
  const edit = useContextEditor(taskFields);
  const { open, close } = edit;
  const { changing } = useAppState();
  useEffect(() => {
    if (changing) return;
    if (subject) void open({ subject, context });
    else void close();
  }, [subject, context, changing, open, close]);
  const editor =
    subject &&
    edit.target?.subject === subject &&
    edit.target.context === context
      ? edit.editor
      : null;
  // Escape, Close and a press beside the dialog: the SDK asks first.
  const requestClose = async () => {
    if (await edit.close()) leave();
  };
  return (
    <Dialog
      isOpen={subject !== null}
      onOpenChange={(next) => {
        if (!next) void requestClose();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t.rename}</DialogTitle>
      </DialogHeader>
      {edit.phase === 'unavailable' && edit.problem ? (
        // A Context the app cannot read: its problem, not a loading notice.
        <p role="alert">{messages.contextProblems?.[edit.problem]}</p>
      ) : (
        <ResourceEditor
          editor={editor}
          quiet
          onClose={() => void requestClose()}
          labels={{ title: t.title }}
        >
          {(draft, change) => (
            <label className="grid gap-1.5">
              {t.title}
              <Input
                value={draft.title}
                onChange={(e) => change({ ...draft, title: e.target.value })}
                required
              />
            </label>
          )}
        </ResourceEditor>
      )}
    </Dialog>
  );
}
```

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
  given. Full screen, in an app with `viewport-fit=cover`, its heading and
  content add the device's safe-area insets (`env(safe-area-inset-*)`) to
  their padding: Close sits below a notch, the heading and fields beside a
  landscape cutout, the last action above the home indicator. Without insets
  and in the centred dialog nothing changes, so an app's own inset padding
  around it can go.
- **`HeaderMenu`**: a round 44px icon button (`icon="menu"` or `"more"`) with a
  menu of actions, separators (`null`) and submenus of checked choices
  (`{ label, choices: [{ label, checked, onSelect }] }`; give choices an `id`
  when their labels can repeat). An action's own `icon` is a decorative
  leading icon (`{ label, onSelect, icon: <UsersIcon /> }`, shown at 16px,
  so give it no size of its own): it is hidden from assistive technology, so
  the label stays the item's name and leads typeahead. Once one action has an
  icon, every other row keeps an empty icon space, so the labels start in one
  column in either reading direction; submenus take no icon. Rows stay 44px
  high. Arrow keys move,
  ArrowRight opens a submenu, ArrowLeft and Escape close one level, focus
  returns to the button. `ref` reaches the button: pass it as `focusTarget`
  to a surface an item opens, such as `AppAccess`, so focus returns there
  once the item has gone (see the menu example below).
- **`DateChooser`**: the calendar-date chooser for the SDK's `date` field. It
  takes the field's draft value (`2026-10-29`, with `orDateTime` also a zoned
  date-time, or `null`) and returns a day as `YYYY-MM-DD`, or `null` with
  "Remove date" when `optional`. Days are React Aria `CalendarDate` values
  without time or zone, so the stored day does not depend on the device's time
  zone. A choice takes effect only with Apply; Escape or a press beside it keeps
  the draft. A stored date-time is shown in the SDK provider's time zone; the
  chooser starts at the day of its stored offset and replaces it only when a
  day is applied. A value the `date` field does not accept, such as one that
  names no real day (`2026-02-30`) or a date-time without a time zone, is shown
  as stored and opens without a chosen day; so is a value written with a year
  outside 0001–9999. Month names and the first weekday follow the SDK
  provider's locale; days and month buttons are 44px targets. Apply and Remove
  date stay in a bar at the chooser's bottom edge, visible on a phone as it
  opens.
- **`ActionButton`**: an app's own action in the theme's variants: `variant`
  `primary` (default), `secondary`, `ghost` or `destructive`; `shape` `pill`
  (56px high), `round-sm` (44px, as `HeaderMenu`'s button, for icon actions
  in a heading), `round` (56px) or `round-lg` (72px); `label` names an
  icon-only button. **`ActionLink`** looks the same and is a real link, for
  an action with an address (`{...nav.link(place)}`), so it can be opened in
  a new tab or copied.
- **`ActionGroup`**: a labelled row of actions, the full width on phones and at
  most 26rem wide and centred above. `pill` actions share the free width,
  round ones keep their size, and each action stays its own Tab stop.
- **`ChipGroup`** and **`Chip`**: filter chips. `ChipGroup` takes a `label`
  and React Aria's selection props (`selectionMode` `single` by default or
  `multiple`, `selectedKeys`, `onSelectionChange`, `disallowEmptySelection`);
  each `Chip` has an `id`. Chips are 44px high and wrap on narrow screens. A
  chosen chip is filled with the primary role and shows a check mark, so its
  state does not rest on colour alone. Tab reaches the group once, arrow keys
  move between chips, and Space or Enter chooses one.
- **`WorkspacePanel`**: a nonmodal panel over a workspace, such as filters
  or details beside a canvas or a map that stays usable behind it. It is a
  region named by its heading, with optional `actions` and Close; there is no
  backdrop, no focus trap, and a press beside it does not close it. Like
  `ScreenDialog` it is controlled: Close and Escape, while the focus is in
  the panel, call `onRequestClose`, and it closes when `open` turns false.
  Opening moves the focus into the panel (`autoFocus={false}` keeps it where
  it is, for a panel that follows a selection); closing with the focus in it
  returns the focus to the element it opened from, or to `focusTarget`, and
  focus the person moved to the workspace stays there. It floats over the
  workspace instead of taking its space, so the workspace keeps its size and
  stays mounted. From 640px it floats at the `end` (default) or `start` edge,
  up to 22rem wide and as high as its content; below, it fills the width at
  the bottom, up to 70% of the height. Its content scrolls inside it, and it
  keeps clear of the device's safe-area insets. Its surface is the theme's
  `popover` role, slightly translucent with a blur where the browser blurs,
  solid with reduced transparency or more contrast. It sits below SDK
  dialogs, confirmations and prompts and below `ScreenDialog`, which covers
  it while open. Show one panel at a time on phones, where panels share the
  bottom edge.

A main action usually stands alone above a group of the others, as in the
reference screen's Zen view:

```tsx
// zen-actions.tsx
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import {
  ActionButton,
  ActionGroup,
  ActionLink,
  type NavLinkProps,
} from '@sempods/app-ui';

export function ZenActions(props: {
  readonly complete: () => void;
  readonly previous: () => void;
  readonly next: () => void;
  /** The task's "Not today" address, from `nav.link(…)`. */
  readonly postpone: NavLinkProps;
}) {
  return (
    <>
      <ActionButton shape="round-lg" label="Complete" onPress={props.complete}>
        <CheckIcon />
      </ActionButton>
      <ActionGroup label="Task actions">
        <ActionButton
          variant="secondary"
          shape="round"
          label="Previous task"
          onPress={props.previous}
        >
          <ChevronLeftIcon />
        </ActionButton>
        <ActionLink variant="secondary" {...props.postpone}>
          Not today
        </ActionLink>
        <ActionButton
          variant="secondary"
          shape="round"
          label="Next task"
          onPress={props.next}
        >
          <ChevronRightIcon />
        </ActionButton>
      </ActionGroup>
    </>
  );
}
```

Filter chips with one choice that cannot be emptied:

```tsx
// task-filter.tsx
import { Chip, ChipGroup } from '@sempods/app-ui';

export function TaskFilter(props: {
  readonly shown: 'open' | 'all';
  readonly show: (shown: 'open' | 'all') => void;
}) {
  return (
    <ChipGroup
      label="Show"
      disallowEmptySelection
      selectedKeys={[props.shown]}
      onSelectionChange={(keys) => props.show(keys.has('all') ? 'all' : 'open')}
    >
      <Chip id="open">Open</Chip>
      <Chip id="all">All</Chip>
    </ChipGroup>
  );
}
```

A header menu that opens Pods & sharing gives `AppAccess` its button as
`focusTarget`. The chosen item has left with the menu by the time management
closes, so Escape or Close would otherwise leave the focus on the page:

```tsx
// app-menu.tsx
import { useRef, useState } from 'react';
import { UsersIcon } from 'lucide-react';
import { AppAccess, useSdkLocale } from '@sempods/app-sdk/react';
import { HeaderMenu } from '@sempods/app-ui';

export function AppMenu() {
  const [managing, setManaging] = useState(false);
  const menu = useRef<HTMLButtonElement>(null);
  const { messages } = useSdkLocale();
  return (
    <>
      <HeaderMenu
        ref={menu}
        label="Menu"
        items={[
          {
            label: messages.controls.dataAccess,
            onSelect: () => setManaging(true),
            icon: <UsersIcon />,
          },
        ]}
      />
      <AppAccess
        appName="Focus"
        open={managing}
        onClose={() => setManaging(false)}
        focusTarget={menu}
      />
    </>
  );
}
```

A workspace with a canvas and a filter panel. The canvas keeps its size and
element while the panel opens and closes, and stays usable beside it:

```tsx
// workspace.tsx
import { useState } from 'react';
import { SlidersHorizontalIcon } from 'lucide-react';
import { useMessages } from '@sempods/app-sdk/react';
import { ActionButton, Chip, ChipGroup, WorkspacePanel } from '@sempods/app-ui';

const texts = {
  en: {
    graph: 'Graph',
    filters: 'Filters',
    show: 'Show',
    tasks: 'Tasks',
    notes: 'Notes',
  },
  de: {
    graph: 'Graph',
    filters: 'Filter',
    show: 'Anzeigen',
    tasks: 'Aufgaben',
    notes: 'Notizen',
  },
};

export function Workspace() {
  const t = useMessages(texts);
  const [filters, setFilters] = useState(false);
  const [shown, setShown] = useState(new Set<string | number>(['tasks']));
  return (
    // The app places the workspace; the panel floats over it.
    <div className="absolute inset-0 overflow-hidden">
      {/* Focusable for its own keys; Escape here belongs to the canvas. */}
      <canvas className="size-full" tabIndex={0} aria-label={t.graph} />
      <div className="absolute top-4 right-4">
        <ActionButton
          variant="secondary"
          shape="round-sm"
          label={t.filters}
          aria-expanded={filters}
          onPress={() => setFilters((open) => !open)}
        >
          <SlidersHorizontalIcon />
        </ActionButton>
      </div>
      <WorkspacePanel
        title={t.filters}
        side="start"
        open={filters}
        onRequestClose={() => setFilters(false)}
      >
        <ChipGroup
          label={t.show}
          selectionMode="multiple"
          selectedKeys={shown}
          onSelectionChange={(keys) => setShown(new Set(keys))}
        >
          <Chip id="tasks">{t.tasks}</Chip>
          <Chip id="notes">{t.notes}</Chip>
        </ChipGroup>
      </WorkspacePanel>
    </div>
  );
}
```

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
  - `close(fallback)`: back to the in-app place that opened the screen (its
    position is kept in `history.state`, so this also works past the screen's
    fragment links), or after a
    direct entry to `fallback` in place;
  - `link(place)`: `href` and `onClick` for an `<a>`; a plain click switches
    in place, Ctrl/Cmd-, Shift- and middle clicks open the address in the
    browser as usual.
- **`replaceUrl`**: pass it to `createBrowserRuntime`, so the address the
  runtime returns to after sign-in is the one the app shows.

Call `useNav` once, in the app's frame inside `SempodsProvider`, with a
module-level address model, and pass `nav` down: it changes only with the
place. While the SDK asks about a Back or Forward, further history moves
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

/** An absolute IRI, as the SDK accepts it: a scheme and a rest. */
const absolute = (value: string) => /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(value);

/** A subject IRI as one path segment: UTF-8 in base64url. */
function encode(iri: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(iri))
    binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
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
and edits the Context it names (an address with a source opens it right after
sign-in, without choosing a Context first), and not-found places get an
explicit page once the person is connected (a modal before that would block
sign-in):

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
    // A TargetScreen asks for a Context; a task address with its source
    // opens without one.
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <Frame />
    </SempodsProvider>
  );
}

function Frame() {
  const nav = useNav(places);
  const { place } = nav;
  const { connections, view } = useAppState();
  const signedIn = connections.length > 0;
  const list = place.kind === 'list';
  return (
    <main>
      {signedIn && (
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
      {/* A task address that names its source opens without a selected
          Context: no TargetScreen, so AppAccess asks for no choice. */}
      {place.kind === 'task' && place.context && !view ? (
        signedIn && (
          <TaskDialog
            subject={place.subject}
            context={place.context}
            title={place.action === 'postpone' ? 'Not today' : undefined}
            leave={() => nav.close({ kind: 'zen' })}
          />
        )
      ) : (
        <TargetScreen>
          <Tasks nav={nav} />
        </TargetScreen>
      )}
      {place.kind === 'not-found' && signedIn && (
        <ScreenDialog
          title="Not found"
          open
          onRequestClose={() => nav.go({ kind: 'zen' }, { replace: true })}
        >
          <p>
            {place.reason === 'invalid'
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
restore; Save after cancelled closes; closing right after opening; cancelled
SDK questions above the compact quick edit and its German Close; the full
screen dialog with emulated safe-area insets (Chromium only); resizing
with a draft; Back and Forward with a dirty draft; the calendar-date roundtrip
in three time zones; keyboard use of menus, the calendar and filter chips;
44px targets; the action group's width on a phone and a desktop; the routed
screen and the SDK's Pods & sharing sheet inside the visible width beside a
page scrollbar (where the engine draws one that takes width; otherwise the
check reports a skip); the
cascade with the SDK's styles; the role pairs of both palettes in all six
combinations in light and dark; rendered screen contrast in four combinations; and the router's 29-check matrix of
links, direct and signed-out entry, Close, Back and Forward with a dirty
draft, history moves while the SDK asks, reload, legacy links and the source
Context, plus fragment entries, a source address without a Context choice and
a path with two leading slashes. It uses a loopback fixture Pod: it is not
evidence from a real Pod, an installed PWA, iOS or a human test.

## Limits

- The role check samples colours on the root element. Run it under each browser
  preference to cover both schemes. Build tools can compile `light-dark()`
  into media queries, which follow the browser preference even when a page
  script changes the root colour scheme.
- Missing, invalid and context-dependent `currentColor` roles throw with the
  role name. The checker restores the page attributes on error.
- Check screens visually as well. Classes on individual controls, nested
  themes, opacity, images and interactions can change what a person sees.
- The router does not protect leaving the document: Back past its first
  entry, a reload or closing the tab is the SDK's `beforeunload` prompt.
- History entries that other code writes with `pushState` carry no router
  position. The router measures them by the Navigation API's entry index;
  in a browser without it, staying on one shows the shown address again in
  place, and later Back and Forward decisions count that entry as the shown
  one.
- `ScreenDialog`'s safe-area padding is checked with insets that Chromium
  emulates, not on an iPhone, an Android phone or an installed PWA. It reads
  only `env(safe-area-inset-*)`, which is 0 unless the app's viewport sets
  `viewport-fit=cover`. The centred dialog above 640px keeps its margins of
  at least 1rem and adds no insets.
- The UI layer adds about 97 KB of gzipped JavaScript to an app (measured in
  the spike with the same components).

Code is licensed under Apache-2.0, documentation under CC BY 4.0; the shadcn/ui
components are adapted under MIT (see [NOTICE](NOTICE) and
[provenance](PROVENANCE.md)).
