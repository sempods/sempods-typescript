# Source provenance

## shadcn/ui components

`src/components/*.tsx` were generated with `shadcn add` (shadcn 4.23.0, style
`aria-nova`, MIT, see [NOTICE](NOTICE)) in the template's UI spike
(sempods/sempods-apps-template#120) and taken from the spike branch
`claude/120-ui-spike` at `368057f`, `spikes/120-ui/ui-aria/src/components/ui/`:
`button`, `calendar`, `dialog`, `dropdown-menu`, `input`, `input-group`,
`popover`, `select` and `textarea`. `badge`, `toggle` and `toggle-group`
were taken on 2026-11-02 from the same style's registry
(`https://ui.shadcn.com/r/styles/aria-nova/<name>.json`) for chips
(sempods/sempods-typescript#216), with the same mechanical changes and no
others. `combobox` was taken on 2026-11-11 from the same registry for
suggestion fields (sempods/sempods-apps-template#144). `checkbox` was taken
on 2026-11-16 from the same registry for ticking list rows
(sempods/sempods-typescript#337).

Changes against the registry output:

- `checkbox.tsx`: a 20px box (`size-5`, registry `size-4`) inside a 44px
  target (`after:-inset-[13px]` from inside the 1px border, registry
  `after:-inset-x-3 after:-inset-y-2`),
  so a row's tick meets the kit's touch target; the check mark is lucide's
  `CheckIcon` at 16px, hidden from assistive technology, and an
  indeterminate box shows `MinusIcon` on the primary surface (the registry
  shows the check mark for both); `cursor-pointer`. The registry's
  `"use client"` and icon placeholder are dropped, as for the other files.

- `button.tsx`: the `default` and `secondary` variants read the contract's
  action tokens (`bg-action`, `border-action-border`, `text-action-foreground`,
  `bg-action-secondary`, …) instead of `primary` and `secondary` directly;
  their hover mixes the role's own text into its surface, as the SDK's
  actions do.
- `button.tsx`: a `ghost` link to the shown place (`aria-current="page"`,
  as the router's `nav.link` sets it) is chosen in the kit's selection
  language: the `muted` surface with `foreground` text, also in dark mode
  and while hovered, and a 2px underline, so it does not rest on the surface
  alone (sempods/sempods-typescript#343).
- `button.tsx`: a menu trigger (`aria-haspopup="true"`) gets no focus ring
  or border change of its own; its one keyboard indicator is the focus
  outline, drawn from React Aria's `data-focus-visible`
  (sempods/sempods-typescript#232).
- `dropdown-menu.tsx`: rows take the accent surface while hovered, pressed or
  focused by keyboard (`data-hovered`, `data-pressed`, `data-focus-visible`)
  instead of whenever they hold the focus (`focus:`), and the menu no longer
  mixes 10% of the text colour into a focused row. Hovering moves the focus to
  the row, and it keeps the focus while the pointer crosses a separator; the
  row now stays neutral there (#232).
- `dropdown-menu.tsx`: `DropdownMenu` keys its popover by the number of
  times it has opened, so a menu opened again during its exit animation
  mounts a new popover, whose menu takes the focus, instead of keeping the
  closing one (sempods/sempods-typescript#391).
- `dialog.tsx`: no entry or exit animation on the overlay and the modal. In
  WebKit, React Aria kept a modal that closed during its entry animation
  mounted for good (`data-entering` and `data-exiting` at once); in headless
  WebKit on Linux its exit animation stalled for seconds, and React Aria
  unmounts the modal only when that animation ends.
- `dialog.tsx`: the close buttons of `Dialog` and `DialogFooter` take the
  SDK's "Close" text in the provider's language (English without one) unless
  `closeLabel` is given, and a press in a native modal `<dialog>`, such as an
  SDK confirmation, never closes `Dialog`; an app's
  `shouldCloseOnInteractOutside` applies on top
  (sempods/sempods-typescript#229).
- `dialog.tsx`: `Dialog`'s corner Close is a 44px target (`size-11`, at
  `top-1 right-1`) around the registry's 16px glyph, instead of the 28px
  `icon-sm` box at `top-2 right-2`; while it shows, a `DialogHeader` or
  `DialogTitle` that is a direct child keeps `pr-10` clear of it
  (sempods/sempods-typescript#288). The `icon-sm` button size is unchanged.
- `dialog.tsx`: `DialogFooter` is one wrapping row in document order at
  every width (`flex flex-wrap justify-end`, registry `flex flex-col-reverse`
  and `sm:flex-row sm:justify-end`), as the SDK's confirmations; a button
  or `DialogClose` directly in it is at least 44px high, a `pill` 56px, at most as wide as the
  footer and wraps its label (`h-auto`, `py-1`, `whitespace-normal`,
  `text-center`). `Dialog`'s content and inner dialog have one
  `minmax(0,1fr)` column (`grid-cols-1`) and `wrap-anywhere`, so a long label
  or name cannot widen them (sempods/sempods-typescript#368).
- `calendar.tsx`: without the registry's `showWeekNumber` option, which only
  shifted the cells' rounding: React Aria renders no week-number column.
- `calendar.tsx`: with `captionLayout="dropdown"` and several months, only
  the first month gets the month and year pickers, which follow the first
  visible month; later months show their own heading.
- `select.tsx`: `SelectValue` keeps children it is given; the selected-text
  fallback applies only without children.
- `combobox.tsx`: without the parts for choosing several values
  (`ComboboxChips`, `ComboboxChip`, `ComboboxChipList`,
  `ComboboxChipsInput`, `ComboboxValue`) and without `ComboboxClear` and
  `ComboboxInput`'s `showClear`, whose button had an English name only; the
  icons are lucide's (`ChevronDownIcon`, `CheckIcon`) in place of the
  registry's icon placeholder. `ComboboxContent` drops the registry's
  `cn-menu-target` and `cn-menu-translucent` hooks, which this package does
  not define, and the 10% text colour it mixed into a focused row, as the
  menu does (#232).
- All files: relative imports with `.js` extensions, no `"use client"`
  directive, Prettier formatting.

`styles.css` copies the state variants (`@custom-variant data-open`, …) of
shadcn's `tailwind.css` from the same version; the accordion keyframes,
scroll-fade and shimmer utilities are not used and not copied.

## Adapters, contract and gate

`src/adapters/` and the token contract in `styles.css` port the spike's
`ui-aria/src/kit.tsx` and `harness/src/theme.css` (same commit) into typed
components. Changed on the way: the SDK bridge uses the SDK's field, action and
focus tokens (sempods/sempods-typescript#200), the date chooser takes the SDK
`date` field's value and offers removing it, texts come from the SDK provider's
language, and palette defaults sit in the `theme` layer without specificity.
`SuggestField` (`src/adapters/suggest-field.tsx`) and its single focus cue
in `styles.css` are this package's own, written on the registry's combo box
for sempods/sempods-apps-template#144; its address mode (`suggest`) and input
`ref` are for sempods/sempods-typescript#324, its suggestions' `media` box
and its `notice` line for sempods/sempods-typescript#361. Its popover is a
flex column, so that the lines under the list stay inside its height. `src/adapters/aria-count.ts`
keeps React Aria's combo box count for the field out of React Aria's
announcer (sempods/sempods-typescript#326). It relies on that announcer's
region (`data-live-announcer` with two `role="log"` children), on the combo
box announcing its count in the effects of the commit in which its list
opens or the count changes, after the field's own, and on its first message
following 100ms after it creates the region. It leaves out only a message
that is exactly React Aria's count: `src/adapters/aria-count-text.ts` copies
React Aria's `countAnnouncement` strings for `@react-aria/combobox`
(Apache-2.0) and their choice by locale. The unit tests, which compare that
copy with the installed React Aria in every locale, and the UI gate's
`search-live-regions` check all this after a React Aria update.

`ContextSwitch` (`src/adapters/context-switch.tsx`) is an SDK-aware composition
for sempods/sempods-typescript#290 and sempods/sempods-apps-template#155.
Its spacing, Pod groups, permission legend and address disclosure belong to
this adapter; the registry Button and menu primitives are unchanged.

The browser gate (`scripts/test-ui-consumer.mjs`, `scripts/ui-checks.mjs`,
`scripts/ui-contrast.js`, `scripts/ui-pod.mjs` and `tests/ui-browser/`) ports
the spike's `scripts/gate.mjs`, `roundtrip.mjs`, `interaction.mjs`,
`evidence.mjs`, `contrast.js`, `contrast-selftest.mjs` and the harness's fake
Pod and reference screen. It runs against the packed packages and a Vite
production build instead of the spike's dev servers; the fixture Pod applies
merge patches as RFC 7396 describes, and WebKit on macOS moves the focus with
Option+Tab, as Safari does by default for buttons.

## Router

`src/router/nav.ts` is the template's own router
(`packages/apps/skeleton/app/src/routes.ts` of sempods/sempods-apps-template,
MIT No Attribution, same author) as extended and
corrected in the template's routing spike (#114, branch
`claude/120-ui-spike`, `spikes/120-ui/apps/authoring-own/src/sempods/router.tsx`):
resource and action addresses through an app-owned address model, an
opener-aware `close`, and one decision for history moves while the SDK asks.
Changes against the spike: the history session starts on first use instead of
at import, one popstate listener for all mounted frames, no decision for a
move to the shown address, a fragment link's entry takes the next position
and the opener's position (so `close` returns past it), `close` going back by
that position instead of by the opener's address, and `link` leaving clicks
with a `target` to the browser.
