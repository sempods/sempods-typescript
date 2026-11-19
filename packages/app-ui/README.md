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
[cascade layer guide](https://github.com/sempods/sempods-typescript/blob/v0.9.0-dev.3/docs/react-authoring.md#cascade-layer-order)
(installed as `node_modules/@sempods/app-sdk/docs/react-authoring.md`)
explains the order and which app rules still override SDK rules.

`styles.css` adds:

- the palette roles as Tailwind colours (`bg-primary`, `text-muted-foreground`,
  `border-input`, `bg-action`, …) and the radius scale;
- default role values (the shared sage palette) in the `theme` layer without
  specificity, so any `:root` rule of the app wins;
- the component variants and the bridge to the SDK tokens (below);
- shadcn's state variants (`data-open:`, `data-disabled:`, …) and the
  `tw-animate-css` animations of popovers and menus;
- in `base`: borders without a colour class take the `border` role, the body
  takes `background` and `foreground`, and app links, buttons and fields get a
  solid focus outline;
- in its own layer `app-ui-focus`, after Tailwind's utilities: a solid 2px
  focus outline in the `ring` colour on the package's components, on an app's
  elements drawn with `buttonVariants` (such as [view links](#views-as-links))
  and on calendar days. Menu triggers and menu rows show it only for keyboard focus, as
  React Aria's `data-focus-visible` reports it, and a row draws it inside its
  edge; with forced colors, the focused row draws it for pointer focus too.
  A `Checkbox` draws it on its visible box while its hidden input has
  keyboard focus, also with forced colors.
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
| all      | foreground                  | muted                  | background                | rest  | 4.5           |
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
`Calendar`, `RangeCalendar`, `Checkbox`, `Dialog` and its parts,
`DropdownMenu` and its parts, `Input`, `InputGroup` and its parts,
`Combobox` and its parts, `Popover` and its parts, `Select` and its parts,
`Textarea`, `Toggle`, and `ToggleGroup` with `ToggleGroupItem`. `Badge` suits
read-only tags. shadcn's
[aria-nova documentation](https://ui.shadcn.com/docs/components) describes
them. The adapters below are the sempods compositions; prefer them for screens,
menus, dates and actions.

`Checkbox` ticks a list row: a 1.25rem box inside a 2.75rem target (20px and
44px at the default text size; both grow with the root font size, as a
`size-11` control does), filled with the `primary` role and a check mark when selected (a dash while
`isIndeterminate`), the kit's focus ring for the keyboard, and Space or a press
to change it. It takes React Aria's `isSelected`, `onChange` and
`isDisabled`. Name it with `aria-label`, for example `Done: Buy milk` beside
a title that opens the row, or with `aria-labelledby` pointing at visible
text; it has no label slot of its own:

```tsx
// task-row.tsx
import { Checkbox } from '@sempods/app-ui';

export function TaskRow(props: {
  readonly title: string;
  readonly done: boolean;
  readonly canChange: boolean;
  readonly toggle: (done: boolean) => void;
  readonly open: () => void;
}) {
  return (
    <li className="flex min-h-12 items-center gap-3 border-b px-3">
      <Checkbox
        aria-label={`Done: ${props.title}`}
        isSelected={props.done}
        isDisabled={!props.canChange}
        onChange={props.toggle}
      />
      <button
        className="min-h-11 flex-1 text-start wrap-anywhere"
        onClick={props.open}
      >
        {props.title}
      </button>
    </li>
  );
}
```

The compact `Dialog` names its close buttons (the corner one and
`DialogFooter`'s `showCloseButton`) with the SDK's "Close" text in the
provider's language, or English without a provider; `closeLabel` replaces it.
The corner Close is a 44px target around a 16px glyph, without app CSS; a
`DialogHeader` or `DialogTitle` placed directly in the `Dialog` keeps its right
edge clear of it. `showCloseButton={false}` removes both, for example while the
app runs a batch that must not be left.
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

A short confirmation of the app's own operation, for example clearing the
bought items of a list, needs no component of its own: a `Dialog` with a
`DialogFooter` that holds two `DialogClose` buttons, Cancel first and the
answer with `variant="default"` and its `onPress` last. Both close the dialog.
The footer keeps its actions in one row in that order at every width, as the
SDK's confirmations do: Cancel left, the answer right. Actions that do not fit
side by side wrap to another row, and a label wraps only when its action
alone is too wide; each button is a 44px target, and `ActionButton` pills
keep their 56px there. A long name in the dialog breaks inside it. The SDK's
own questions, such as `RemoveButton`'s and an editor's, stay the SDK's.

```tsx
// confirm-dialog.tsx
import type { ReactNode } from 'react';
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@sempods/app-ui';

export function ConfirmDialog(props: {
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly children: ReactNode;
  readonly cancel: string;
  readonly confirm: string;
  readonly onConfirm: () => void;
}) {
  return (
    <Dialog
      isOpen={props.isOpen}
      onOpenChange={props.onOpenChange}
      // Cancel is the way out; Escape and a press beside it still cancel.
      showCloseButton={false}
    >
      <DialogHeader>
        <DialogTitle>{props.title}</DialogTitle>
        <DialogDescription>{props.children}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <DialogClose>{props.cancel}</DialogClose>
        <DialogClose variant="default" onPress={props.onConfirm}>
          {props.confirm}
        </DialogClose>
      </DialogFooter>
    </Dialog>
  );
}
```

React Aria gives the components their locale: the order of typeahead,
number and date formats, the reading direction and the texts it announces
itself. Without a provider they follow the browser, so an app wraps its
content in the re-exported `I18nProvider` with the locale it passes to the
SDK's provider, and the kit follows the app's language and region:

```tsx
// app-locale.tsx
import type { ReactNode } from 'react';
import { SempodsProvider } from '@sempods/app-sdk/react';
import type { BrowserRuntime } from '@sempods/app-sdk';
import { I18nProvider } from '@sempods/app-ui';

export function AppProviders(props: {
  readonly runtime: BrowserRuntime;
  readonly language: 'en' | 'de';
  readonly locale: string;
  readonly children: ReactNode;
}) {
  return (
    <SempodsProvider
      runtime={props.runtime}
      language={props.language}
      locale={props.locale}
    >
      <I18nProvider locale={props.locale}>{props.children}</I18nProvider>
    </SempodsProvider>
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

- **`ScreenDialog`**: a routed screen as a modal, full screen below 640px wide
  or 480px high and up to 42rem wide otherwise, with a heading, optional
  `actions` and Close. Its content scrolls below the standing heading; below
  320px high, such as a phone in landscape with its keyboard open, the heading
  scrolls with the content, because Chromium scrolls the focused field to the
  top of the viewport. It is
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
- **`ContextSwitch`**: the standard header chooser for an app working in one
  Context at a time, across all connected Pods. Supply the app's `title`, an
  optional decorative `icon`, its word for a Context (`label`, e.g. "List"),
  optional `texts` that name its Contexts in the adapter's messages
  (`shareContexts`, `chooseContext`, `contextsLoading`, `contextsFailed`,
  `contextsEmpty`, `switchUnavailable`, `actionNotCompleted`, `noPods`; each
  left out keeps its default), and optional `podNames` keyed by exact Pod URL.
  Mount outside `TargetScreen`, alongside `AppAccess`. It initially selects
  the active Pod's first writable, else readable Context when none was
  remembered or configured, just like `useContexts`.

  The chooser only selects. Changing what is shared, connecting Pods and
  signing out stay in `AppAccess` (an app's **Pods & sharing**), so the
  chooser's own menu has no permanent sharing action, no address details and
  no icon legend. That describes the component, not a rule for apps: an app
  may still offer its own sharing entry, for example in a `HeaderMenu`, with
  `useContexts().share()` beside `ContextSwitch`
  ([changing sharing](https://github.com/sempods/sempods-typescript/blob/v0.9.0-dev.3/docs/react-authoring.md#changing-what-the-app-may-access),
  installed as `node_modules/@sempods/app-sdk/docs/react-authoring.md`).

  The trigger keeps the app icon the same size and places the chevron beside
  the Context name. With several Pods, the Pod appears directly below the
  Context. With one Pod, its name is available to screen readers. The menu
  indents Context names below each Pod heading and leaves space between Pods.
  Rows are at least 2.75rem tall (44px at the default text size). Equal
  names within one Pod show their `qualifier` more quietly; equal names on
  different Pods need none. An editable Context has no mark; a read-only one
  shows a small **Read only** badge (German **Nur lesen**), and the check
  marks the selection separately. Each row's accessible description names its
  Pod and access, and whether it is unavailable. Long names wrap in the menu;
  the trigger keeps the full name available to assistive technology. Only URL
  fallbacks for Pod names lose a terminal slash (and are decoded); supplied
  names keep theirs. Escape closes the popup and returns focus to the trigger.

  The adapter owns loading, empty, signed-out and failed groups, per-Pod
  retry/sign-in, unavailable retained choices, blocked selection and share
  errors. A Pod that loaded and shares no readable Context offers
  **Share contexts …** for that Pod, including an inactive one; a loading,
  failed or signed-out Pod offers its retry or sign-in instead. Under
  `signIn: 'none'` it offers neither. Sharing asks the Pod for its consent
  page, also when it could reuse the grant; a sign-in action may reuse it. A
  read-only Context stays selectable; a retained one that is unavailable does
  not. Sign-in and retry actions identify their Pod for assistive technology
  and typeahead. SDK actions still own draft/pending/unconfirmed-write guards.
  Apps supply domain words and content, not a second catalogue, guard or
  generic recovery UI. `AppAccess` keeps access management and its own focus
  target. No global Button or menu padding changes are needed.

- **`HeaderMenu`**: a round 44px icon button (`icon="menu"` or `"more"`) with a
  menu of actions, separators (`null`) and groups of checked choices
  (`{ label, choices: [{ label, checked, onSelect }] }`; give choices an `id`
  when their labels can repeat). A group opens as a submenu, or with
  `display: 'section'` lists its choices in the menu under its label as a
  heading: for two or three choices, such as a View with Zen and List, a
  section shows the current one at once and needs no second layer on a phone.
  A choice's `description` adds a second line ("Can read") that describes it
  without becoming part of its name. `lang` on a choice or an action marks a
  label in another language than the page's, such as a language named in
  itself (`{ label: 'Deutsch', lang: 'de', … }` in an English menu), so
  assistive technology reads it in that language; the name stays the label. `disabled` on an action or a choice keeps
  it visible but out of reach: a press does nothing and arrow keys skip it.
  `variant="ghost"` shows only the icon until it is hovered, pressed or open,
  for a menu repeated on every row, with the same 44px target. An action's own `icon` is a decorative
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
  opens. It holds a `DateChoice`, so `presets`, `min` and typed entry work
  the same; a preset applies and closes at once.
- **`DateChoice`**: the same calendar-day choice without a trigger or
  popover, for an app's own dialog such as a `ScreenDialog`
  ([example](#a-date-choice-in-a-screen-dialog)). `presets` are the app's
  localized `{ label, day }` choices with concrete days (`YYYY-MM-DD`); one
  activation calls `onChange` with its day. A custom day comes from the
  calendar or is typed as `YYYY-MM-DD`, and reaches `onChange` only with
  Apply; Enter in the typed entry neither applies it nor submits a form or
  saves a `ResourceEditor` around the choice. The calendar ends at
  0001-01-01 and 9999-12-31, the days a stored value can name. `min` disables earlier calendar days and presets (they stay
  visible) and marks an earlier typed day invalid; a typed day that does not
  exist (`2026-02-30`) is marked invalid too, and so is a stored `value` before `min` as it opens. Neither is corrected, and Apply
  stays disabled. `optional` adds "Remove date" while there is a `value`,
  which calls `onChange(null)`. `value` is the selected day; a new one from
  the caller, such as a preset's, replaces the person's unapplied draft. The
  app computes the presets' days and decides when to write a value; closing
  the dialog without a call keeps it. Texts follow the SDK provider's
  language, `labels` overrides Apply, Remove date and the typed entry's label.
  The calendar needs 308px of width for its 44px days.
- **`ActionButton`**: an app's own action in the theme's variants: `variant`
  `primary` (default), `secondary`, `ghost` or `destructive`; `shape` `pill`
  (56px high), `round-sm` (44px, as `HeaderMenu`'s button, for icon actions
  in a heading), `round` (56px) or `round-lg` (72px); `label` names an
  icon-only button. **`ActionLink`** looks the same and is a real link, for
  an action with an address (`{...nav.link(place)}`), so it can be opened in
  a new tab or copied. A `ghost` link to the shown place
  (`aria-current="page"`) is drawn chosen, as in
  [views as links](#views-as-links).
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
  the panel, call `onRequestClose`, and it closes when `open` turns false. An
  open combo box in it, such as a `SuggestField`'s suggestions, takes the
  first Escape.
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
- **`SuggestField`**: a text field with suggestions the app finds as the
  person types, such as a search or address bar, on React Aria's combo box.
  It is controlled (`value`, `onChange`) and only shows: the app searches for
  `value`, passes the `items` it found (`{ id, label, detail?, source?, media? }`)
  with `loading` and `failed` (`'some'` or `'all'` of its sources), and
  cancels a search whose text has changed. The input keeps the focus; arrow
  keys move through the suggestions, Enter or a press chooses one
  (`onSelect`), and Escape closes them. Enter, or a phone's Go key, with no
  suggestion active submits the typed text (`onSubmit`), for example an
  address to open, so the bar needs no Open button; an input method that
  is still composing text never submits it. The suggestion the keyboard is
  on keeps its place by `id` while results arrive and reorder. A label wraps
  to two lines, `detail` (an exact IRI) stays on one line and is cut off
  only visually, and `source` names where it was found in a few words;
  assistive technology reads both in full as the suggestion's description. The field announces the number
  of suggestions, a search still running, one that found nothing or failed
  in part or completely, in the SDK provider's language, and each change
  once. It is the only voice for them: React Aria's own option count for
  the field ("0 options available." while the first results load) stays
  out of React Aria's announcer, while the active suggestion, which React
  Aria says for VoiceOver, and other components' announcements still
  reach it. It is 44px high,
  as are the suggestions, and draws one focus cue, the outline around the
  whole field. `labelHidden` names it for assistive technology only, for a
  bar whose placeholder and place say what it is. `suggest={false}` is for
  text the app does not search, such as an exact address, an invalid one or
  a single character: the suggestions stay closed, also when they were
  open, neither the arrow keys nor a touch open them, `items`, `loading`
  and `failed` are ignored and nothing is announced, not even React Aria's
  option count, while the same input keeps its focus, caret and composition
  and Enter submits. When `suggest` turns true again while the field has
  the focus, the suggestions open as typing would open them. Telling an
  address from a search stays with the app. `ref` reaches the input, for
  example to focus and select it on Ctrl/Cmd-K. A suggestion's `media`, an
  element such as a person's photo or an icon for the resource's type,
  shows in a 40px box before the label; an `<img>` fills it, cropped, and an
  icon sized by the app sits in its centre. The app loads a picture itself,
  for example scoped to its source and with a fallback for a broken one, and
  the field does not wait for it. The box is hidden from assistive
  technology, so the label, `detail` and `source` name and describe the
  suggestion as before; once any suggestion has `media`, every one keeps
  the box, so their labels line up, and the rows stay 44px or more.
  `notice` is the app's own quiet line about its search under the open
  suggestions, below the field's status line, such as results cut off at a
  limit, no sources to search yet or a source that needs signing in again.
  It shows also when nothing was found, stays inside the suggestions'
  height while they scroll, and is not announced: the app announces it
  itself when it must. Keep it text: the focus stays in the field, so offer
  an action such as signing in again outside it.

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
closes, so Escape or Close would otherwise leave the focus on the page. Back
on the button, the focus shows its ring after Escape, as after any keyboard
use, and none after a press on Close:

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

A View with two choices as a section, and an action that is not available
yet. The menu opens on the checked view; a choice closes the menu before it
navigates:

```tsx
// view-menu.tsx
import { HeaderMenu } from '@sempods/app-ui';

export function ViewMenu(props: {
  readonly view: 'zen' | 'list';
  readonly show: (view: 'zen' | 'list') => void;
  readonly canExport: boolean;
  readonly exportTasks: () => void;
}) {
  return (
    <HeaderMenu
      label="Menu"
      items={[
        {
          label: 'View',
          display: 'section',
          choices: [
            {
              label: 'Zen',
              checked: props.view === 'zen',
              onSelect: () => props.show('zen'),
            },
            {
              label: 'List',
              checked: props.view === 'list',
              onSelect: () => props.show('list'),
            },
          ],
        },
        null,
        {
          label: 'Export',
          onSelect: props.exportTasks,
          disabled: !props.canExport,
        },
      ]}
    />
  );
}
```

### A date choice in a screen dialog

A "Not today" action that postpones a task: presets for tomorrow and a week
later, no day before tomorrow, and "Remove date" to end the postponement. The
app owns the arithmetic and the write; Escape or Close keeps the stored day.
The UI gate runs this file as written:

```tsx
// not-today.tsx
import { useMessages } from '@sempods/app-sdk/react';
import { DateChoice, ScreenDialog } from '@sempods/app-ui';

const text = {
  en: { title: 'Not today', tomorrow: 'Tomorrow', week: 'In a week' },
  de: { title: 'Nicht heute', tomorrow: 'Morgen', week: 'In einer Woche' },
};

/**
 * The calendar day `days` after `day`, both `YYYY-MM-DD`: the app's own
 * arithmetic, on a day it computed itself, at midnight UTC.
 */
function addDays(day: string, days: number): string {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function NotToday(props: {
  readonly open: boolean;
  /** Today in the app's time zone, as `YYYY-MM-DD`. */
  readonly today: string;
  /** The stored day the task waits for, or `null`. */
  readonly until: string | null;
  readonly postpone: (until: string | null) => void;
  readonly close: () => void;
}) {
  const t = useMessages(text);
  const tomorrow = addDays(props.today, 1);
  return (
    <ScreenDialog
      title={t.title}
      open={props.open}
      onRequestClose={props.close}
    >
      <DateChoice
        label={t.title}
        value={props.until}
        presets={[
          { label: t.tomorrow, day: tomorrow },
          { label: t.week, day: addDays(props.today, 7) },
        ]}
        min={tomorrow}
        optional
        onChange={(until) => {
          props.postpone(until);
          props.close();
        }}
      />
    </ScreenDialog>
  );
}
```

### Secondary actions on rows

Repeated rows, such as Pods and their filters in a side panel, need quieter
actions than a screen: the screen's own actions use `ActionButton` (56px
pills and round buttons in the theme's action variants), a row's actions the
compact `Button` with `variant="ghost"` and a 44px height (`min-h-11`), and a
row's menu `HeaderMenu` with `icon="more"` and `variant="ghost"`. The row's
name wraps instead of being cut off, a count stays secondary text, and each
action keeps its own name, so the keyboard reaches them one by one and focus
returns to the menu's button when its menu closes:

```tsx
// source-row.tsx
import { Button, HeaderMenu } from '@sempods/app-ui';

export function SourceRow(props: {
  readonly name: string;
  readonly count: number;
  readonly shown: boolean;
  readonly toggle: () => void;
  readonly rename: () => void;
  readonly remove: () => void;
}) {
  return (
    <li className="flex min-h-12 items-center gap-1">
      <span className="grid min-w-0 flex-1 px-2">
        <span className="wrap-anywhere">{props.name}</span>
        <span className="text-sm text-muted-foreground">
          {props.count} resources
        </span>
      </span>
      <Button
        variant="ghost"
        className="min-h-11 px-3"
        aria-pressed={props.shown}
        onPress={props.toggle}
      >
        {props.shown ? 'Hide' : 'Show'}
      </Button>
      <HeaderMenu
        icon="more"
        variant="ghost"
        label={`${props.name}: more`}
        items={[
          { label: 'Rename', onSelect: props.rename },
          { label: 'Remove', onSelect: props.remove },
        ]}
      />
    </li>
  );
}
```

### Renaming in a row

`InlineTextEdit` edits one text value in place, such as a shopping item's
name or a label, without the full `ResourceEditor`: an input with **Save** and
**Cancel** (the SDK's texts in the provider's language, or `saveLabel` and
`cancelLabel`). It is controlled and writes nothing itself. It focuses and
selects the value when it mounts; opened from a menu (a row's `HeaderMenu`
**Rename**), it takes the focus that the closing menu hands back to its
button. Enter or Save calls `onSave`, Escape or Cancel `onCancel`. Escape
stays inside it, so an enclosing dialog stays open.

- Moving between its input, buttons and `children` (the row's
  `UpdateNotice`, with its check and acknowledgement) keeps it open, also by
  pointer in WebKit, where a press on a plain button does not focus it.
- A press beside it, a tap on text beside it on a touch device, or Tab past
  it calls `onDismiss`: close the field without saving and keep or drop the
  draft as the app decides. The window losing the focus does not, nor a
  focus that falls to the page, as when a focused control becomes disabled:
  the input takes it back.
- `pending` locks the value while the write runs: Save shows that it is
  pending and keeps its focus, Cancel is unavailable, and leaving then
  dismisses only once the write has settled. `readOnly` (for example
  `!row.canMutate` after a conflict) keeps the input readable and Save
  unavailable; `error` marks the input invalid and describes it.
- `returnFocus` runs when the field unmounts while it holds the focus, after
  the app's render: focus the trigger there. After Save, Cancel or Escape the
  focus returns; after a slow save the person has left meanwhile, it stays
  where they put it.
- Its controls are 44px high; at a narrow width they wrap below the input.

The app owns the trigger and any deep link, the field mapping and
validation, the snapshot it writes from, what a dismissal keeps and its own
list actions. Write with the row's `useFieldUpdate` command; the
[authoring guide](https://github.com/sempods/sempods-typescript/blob/v0.9.0-dev.3/docs/react-authoring.md#renaming-one-value-in-a-row)
explains the recipe. Here a dismissal parks a changed name, marked in its
row and guarded, and the next rename resumes it:

```tsx
// rename-row.tsx
import { useRef, useState } from 'react';
import {
  RemoveButton,
  UnresolvedNotices,
  UpdateNotice,
  useDraftGuard,
  useFieldUpdate,
  useList,
  useMessages,
  useWorkflowAccess,
  type FieldUpdateRow,
} from '@sempods/app-sdk/react';
import type { DraftOf } from '@sempods/client-sdk/edit';
import { Badge, Checkbox, InlineTextEdit } from '@sempods/app-ui';
import { taskFields } from './task-dialog';

type Item = DraftOf<typeof taskFields>;

const texts = {
  en: {
    list: 'Shopping list',
    rename: 'Rename',
    bought: 'Bought',
    details: 'Details',
    remove: 'Delete',
    required: 'Enter a name.',
    unsaved: 'Not saved',
  },
  de: {
    list: 'Einkaufsliste',
    rename: 'Umbenennen',
    bought: 'Gekauft',
    details: 'Details',
    remove: 'Löschen',
    required: 'Gib einen Namen ein.',
    unsaved: 'Nicht gespeichert',
  },
};

/** A list whose item names are renamed in their rows. */
export function ShoppingList(props: {
  /** The app's own address of an item's screen. */
  readonly href: (iri: string) => string;
}) {
  const list = useList(taskFields);
  const mutate = useFieldUpdate(taskFields);
  const { write } = useWorkflowAccess();
  const t = useMessages(texts);
  // The item being renamed, and the drafts by IRI: the open one and those
  // a dismissal parked, until saved or cancelled, each with the name it
  // started from.
  const [open, setOpen] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<
    ReadonlyMap<string, { readonly text: string; readonly from: string }>
  >(new Map());
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const items = list.data?.items ?? [];
  const names = new Map(
    items.map((item) => [item.iri, mutate.for(item).data.title]),
  );
  // A changed name is unsaved work: changing the list or Pod asks first,
  // also while the list cannot be read. Only a list read that no longer
  // shows an item leaves its draft nothing to rename.
  useDraftGuard(
    [...drafts].some(
      ([iri, { text, from }]) =>
        (!list.data || names.has(iri)) &&
        text.trim() !== (names.get(iri) ?? from),
    ),
    () => {
      setDrafts(new Map());
      setOpen(null);
    },
  );
  const setDraft = (iri: string, draft: string | null) =>
    setDrafts((all) => {
      const next = new Map(all);
      const from = all.get(iri)?.from ?? names.get(iri) ?? '';
      if (draft === null) next.delete(iri);
      else next.set(iri, { text: draft, from });
      return next;
    });
  return (
    <>
      <ul aria-label={t.list}>
        {items.map((item) => {
          const row = mutate.for(item);
          const { iri } = item;
          return (
            <ItemRow
              key={iri}
              row={row}
              href={props.href(iri)}
              writable={write}
              draft={drafts.get(iri)?.text}
              editing={open === iri}
              trigger={(button) => {
                if (button) triggers.current.set(iri, button);
                else triggers.current.delete(iri);
              }}
              onOpen={() => {
                setDraft(iri, drafts.get(iri)?.text ?? row.data.title);
                setOpen(iri);
              }}
              onDraft={(draft) => setDraft(iri, draft)}
              onClose={(park) => {
                if (!park) setDraft(iri, null);
                // Another item may be open by now, after a slow save.
                setOpen((current) => (current === iri ? null : current));
              }}
              returnFocus={() => triggers.current.get(iri)?.focus()}
            />
          );
        })}
      </ul>
      <UnresolvedNotices of={mutate} shown={list.data?.items} />
    </>
  );
}

function ItemRow(props: {
  readonly row: FieldUpdateRow<Item>;
  readonly href: string;
  /** Whether the list may be written; without it, names are plain text. */
  readonly writable: boolean;
  /** The open or parked draft of this item's name. */
  readonly draft: string | undefined;
  readonly editing: boolean;
  readonly trigger: (button: HTMLButtonElement | null) => void;
  readonly onOpen: () => void;
  readonly onDraft: (draft: string) => void;
  /** Ends the rename; `park` keeps its draft for the next one. */
  readonly onClose: (park: boolean) => void;
  readonly returnFocus: () => void;
}) {
  const t = useMessages(texts);
  const { row, draft } = props;
  const item = row.data;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const parked = draft !== undefined && draft.trim() !== item.title && !saving;
  const save = async () => {
    const title = (draft ?? '').trim();
    if (!title) return setError(t.required);
    if (title === item.title) return props.onClose(false);
    setSaving(true);
    const outcome = await row.update({ title });
    setSaving(false);
    // Saved: the row shows the new name. Otherwise the draft stays with the
    // row's notice; nothing is sent again.
    if (outcome.kind === 'saved') props.onClose(false);
  };
  const notice = <UpdateNotice {...row.notice} quiet />;
  return (
    <li className="flex min-h-12 flex-wrap items-center gap-x-2 gap-y-1 border-b py-1 *:data-[sempods-ui=notice]:basis-full">
      <Checkbox
        aria-label={`${t.bought}: ${item.title}`}
        isSelected={item.done}
        isDisabled={!row.canMutate}
        onChange={(done) => void row.update({ done })}
      />
      {props.editing ? (
        <InlineTextEdit
          className="min-w-0 flex-1"
          label={`${t.rename}: ${item.title}`}
          value={draft ?? ''}
          onChange={(value) => {
            setError(undefined);
            props.onDraft(value);
          }}
          onSave={() => void save()}
          onCancel={() => {
            setError(undefined);
            props.onClose(false);
          }}
          onDismiss={() => {
            setError(undefined);
            props.onClose(true);
          }}
          returnFocus={props.returnFocus}
          pending={saving}
          readOnly={!row.canMutate}
          error={error}
        >
          {notice}
        </InlineTextEdit>
      ) : (
        <>
          {props.writable ? (
            <button
              ref={props.trigger}
              className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-1 text-start wrap-anywhere hover:bg-muted"
              aria-label={
                `${t.rename}: ${item.title}` + (parked ? ` (${t.unsaved})` : '')
              }
              onClick={props.onOpen}
            >
              {item.title}
              {parked && <Badge variant="outline">{t.unsaved}</Badge>}
            </button>
          ) : (
            <span className="min-w-0 flex-1 px-1 wrap-anywhere">
              {item.title}
            </span>
          )}
          <a
            className="inline-flex min-h-11 items-center px-2 underline"
            href={props.href}
            aria-label={`${t.details}: ${item.title}`}
          >
            {t.details}
          </a>
          {item.done && (
            <RemoveButton
              label={`${t.remove}: ${item.title}`}
              disabled={!row.canMutate}
              onRemove={row.remove}
            />
          )}
          {notice}
        </>
      )}
    </li>
  );
}
```

### A list menu with unavailable choices

A switch between lists, labelled with the current one, shows every list the
SDK knows, also one it reports as not selectable right now (`selectable` of
`usePodContexts`, for example while its Pod reloads): it stays visible and
checked choices keep their mark, but neither a press nor the keyboard
chooses it, and arrow keys move only between the available ones. A
read-only list the SDK reports as selectable stays selectable. Escape closes
the menu with focus back on its button:

```tsx
// list-menu.tsx
import { usePodContexts, useSdkLocale } from '@sempods/app-sdk/react';
import {
  Button,
  DropdownMenu,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@sempods/app-ui';
import { ChevronDownIcon } from 'lucide-react';

export function ListMenu({ shareMore }: { readonly shareMore: () => void }) {
  const lists = usePodContexts();
  const { messages } = useSdkLocale();
  const current = lists.selected;
  return (
    <DropdownMenuTrigger>
      <Button
        variant="ghost"
        className="h-11 max-w-full justify-start gap-2 px-2 text-xl font-semibold"
        aria-label={current ? `List: ${current.name}` : 'List'}
      >
        <span className="truncate">{current?.name ?? 'List'}</span>
        <ChevronDownIcon />
      </Button>
      <DropdownMenu
        placement="bottom start"
        className="w-max min-w-56 max-w-[min(24rem,calc(100vw-2rem))]"
      >
        {lists.pods.map((pod) => (
          <DropdownMenuGroup
            key={pod.connectionId}
            selectionMode="single"
            selectedKeys={current ? [current.key] : []}
          >
            {/* With several Pods, each one heads its lists. */}
            {lists.pods.length > 1 && (
              <DropdownMenuLabel>{pod.name}</DropdownMenuLabel>
            )}
            {pod.choices.map((choice) => (
              <DropdownMenuItem
                key={choice.key}
                id={choice.key}
                className="min-h-11"
                textValue={choice.name}
                isDisabled={!choice.selectable}
                onAction={() => void lists.select(choice)}
              >
                <span className="grid min-w-0 wrap-anywhere">
                  {choice.name}
                  <span className="text-sm text-muted-foreground">
                    {choice.writable
                      ? messages.controls.canChange
                      : messages.controls.canRead}
                  </span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem id="share" className="min-h-11" onAction={shareMore}>
          Share more lists …
        </DropdownMenuItem>
      </DropdownMenu>
    </DropdownMenuTrigger>
  );
}
```

`shareMore` changes sharing: pass `useContexts().share`, or call
`useApp().authorize(id, { intent: 'change-sharing' })` for a given Pod, so the
Pod shows its consent page even when it could reuse the grant. A plain
`authorize(id)` is a sign-in and may return without asking
([changing sharing](https://github.com/sempods/sempods-typescript/blob/v0.9.0-dev.3/docs/react-authoring.md#changing-what-the-app-may-access),
installed as `node_modules/@sempods/app-sdk/docs/react-authoring.md`).
`share()` never rejects; show `useContexts().shareProblem` beside the menu.

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

A search bar that opens a resource from several sources, or an address
typed into it. The app's `search` runs per text and stops when its signal
aborts; it is app code, for example one `pod.find` per connected Pod with
the sources' names. The bar keeps the earlier suggestions while the next
search runs, so the one the keyboard is on stays. A typed address runs no
search: the bar suggests nothing for it, and Enter opens it:

```tsx
// resource-search.tsx
import { useEffect, useState } from 'react';
import { SuggestField, type Suggestion } from '@sempods/app-ui';

/** The app's search over its sources; it stops when `signal` aborts. */
export type Search = (
  text: string,
  signal: AbortSignal,
) => Promise<{
  readonly items: readonly Suggestion[];
  /** Sources whose search failed: some or all of them. */
  readonly failed?: 'some' | 'all';
}>;

interface Found {
  readonly text: string;
  readonly items: readonly Suggestion[];
  readonly failed?: 'some' | 'all';
}

export function ResourceSearch({
  search,
  onOpen,
}: {
  readonly search: Search;
  /** Opens a resource by its IRI. */
  readonly onOpen: (iri: string) => void;
}) {
  const [text, setText] = useState('');
  const [found, setFound] = useState<Found>({ text: '', items: [] });
  const query = text.trim();
  const address = URL.canParse(query);
  useEffect(() => {
    if (!query || address) return;
    const controller = new AbortController();
    // Waits for a pause in typing; a newer text aborts this search.
    const timer = setTimeout(() => {
      search(query, controller.signal).then(
        (result) => {
          if (!controller.signal.aborted) setFound({ text: query, ...result });
        },
        () => {
          if (!controller.signal.aborted)
            setFound({ text: query, items: [], failed: 'all' });
        },
      );
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, address, search]);
  const current = found.text === query;
  return (
    <SuggestField
      label="Address or search"
      labelHidden
      placeholder="Search or enter an address"
      value={text}
      onChange={setText}
      items={query ? found.items : []}
      loading={query !== '' && !current}
      failed={current ? found.failed : undefined}
      suggest={!address}
      onSelect={(item) => onOpen(item.id)}
      onSubmit={(value) => {
        if (URL.canParse(value)) onOpen(value);
      }}
    />
  );
}
```

The adapters' texts ("Menu", "No date", "Apply", "Remove date", the
suggestion field's announcements) follow the SDK provider's language
(English or German); the menu's and the date chooser's can be passed as
props.

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
    browser as usual. A link to the shown place also gets
    `aria-current="page"`: the router compares `format(place)` with the
    canonical address of the shown place, path and query (a fragment is not
    part of it), so a screen over a view marks its own links, not the view's.
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

### Views as links

Views with addresses of their own, such as two lists shown as tabs, can be
plain links instead of a menu: each opens in a new tab or can be copied, and
`nav.link` marks the one to the shown view with `aria-current="page"`.
Drawn with `buttonVariants({ variant: 'ghost' })`, that link is chosen: the
`muted` surface with `foreground` text, and underlined, so the choice does
not rest on the surface alone and stays apart from a hovered link. The look
is the same under every `data-actions` and `data-secondary` value; `min-h-11`
keeps a 44px target. The UI gate renders this file as written:

```tsx
// view-tabs.tsx
import { buttonVariants, type Nav } from '@sempods/app-ui';
import type { Place } from './places';

const tab = buttonVariants({ variant: 'ghost', className: 'min-h-11 px-4' });

export function ViewTabs({ nav }: { readonly nav: Nav<Place> }) {
  return (
    <nav aria-label="Views" className="flex gap-1">
      <a {...nav.link({ kind: 'zen' })} className={tab}>
        Zen
      </a>
      <a {...nav.link({ kind: 'list' })} className={tab}>
        List
      </a>
    </nav>
  );
}
```

## What is checked

The packed browser gate builds a reference screen with Vite and Tailwind 4
against the installed packages and runs in Chromium and WebKit, and in
Firefox on the Linux CI runner. It checks Escape in fields, in SDK
confirmations, on Close, in menus and in the date chooser; focus trap and
restore; Save after cancelled closes; closing right after opening; cancelled
SDK questions above the compact quick edit, its German Close and its 44px
corner Close by pointer and keyboard at 375px and 1280px, light and dark; the full
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
a path with two leading slashes; views as links, their current link
marked by the router and drawn chosen in every action combination;
`rename-row.tsx` with a renaming row menu: keyboard, taps at 320 and 375px,
dismissal and resumption, an invalid name, a denied write, a change on the
Pod, a slow save and the focus after it, read-only access and German names;
and the
"Not today" `DateChoice` in a `ScreenDialog` with a preset, a typed day, an
impossible and an early day, Enter in a form, Remove date, Escape after a
picked day, reopening the date chooser during its exit, the
focus trap and 44px targets without horizontal overflow at 375 and 360px
wide. It uses a loopback fixture Pod: it is not
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
  `viewport-fit=cover`. The centred dialog keeps its margins of at least 1rem
  and adds no insets. Its behaviour with an open keyboard is checked by
  shrinking the viewport, as `interactive-widget=resizes-content` does; a real
  Android keyboard in landscape is not checked (#314).
- The UI layer adds about 97 KB of gzipped JavaScript to an app (measured in
  the spike with the same components).

Code is licensed under Apache-2.0, documentation under CC BY 4.0; the shadcn/ui
components are adapted under MIT (see [NOTICE](NOTICE) and
[provenance](PROVENANCE.md)).
