# Source provenance

## shadcn/ui components

`src/components/*.tsx` were generated with `shadcn add` (shadcn 4.23.0, style
`aria-nova`, MIT, see [NOTICE](NOTICE)) in the template's UI spike
(sempods/sempods-apps-template#120) and taken from the spike branch
`claude/120-ui-spike` at `368057f`, `spikes/120-ui/ui-aria/src/components/ui/`:
`button`, `calendar`, `dialog`, `dropdown-menu`, `input`, `input-group`,
`popover`, `select` and `textarea`.

Changes against the registry output:

- `button.tsx`: the `default` and `secondary` variants read the contract's
  action tokens (`bg-action`, `border-action-border`, `text-action-foreground`,
  `bg-action-secondary`, …) instead of `primary` and `secondary` directly.
- `dialog.tsx`: no entry or exit animation on the overlay and the modal. In
  WebKit, React Aria kept a modal that closed during its entry animation
  mounted for good (`data-entering` and `data-exiting` at once); in headless
  WebKit on Linux its exit animation stalled for seconds, and React Aria
  unmounts the modal only when that animation ends.
- `calendar.tsx`: without the registry's `showWeekNumber` option, which only
  shifted the cells' rounding: React Aria renders no week-number column.
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

The browser gate (`scripts/test-ui-consumer.mjs`, `scripts/ui-checks.mjs`,
`scripts/ui-contrast.js`, `scripts/ui-pod.mjs` and `tests/ui-browser/`) ports
the spike's `scripts/gate.mjs`, `roundtrip.mjs`, `interaction.mjs`,
`evidence.mjs`, `contrast.js`, `contrast-selftest.mjs` and the harness's fake
Pod and reference screen. It runs against the packed packages and a Vite
production build instead of the spike's dev servers; the fixture Pod applies
merge patches as RFC 7396 describes, and WebKit on macOS moves the focus with
Option+Tab, as Safari does by default for buttons.
