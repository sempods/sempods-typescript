# App UI scope

Read the [package overview](README.md) and its [provenance](PROVENANCE.md).
The package depends on app-sdk's public React entry only; app-sdk and
client-sdk never depend on it.

Keep `src/components` close to the shadcn/ui registry output so upstream fixes
can be merged: record every behavioural or styling change in PROVENANCE.md.
Adapters in `src/adapters` compose those components with the SDK; keep them
thin and do not wrap the whole React Aria API.

Classes reach apps through `styles.css` (`@source './dist'`): a class that is
built at runtime from parts is invisible to Tailwind, so write each class out.
Palette defaults stay in the `theme` layer without specificity, so an app's
`theme.css` always wins.

Review the [export budget](src/exports.test.ts) deliberately. Behaviour with
SDK editors and confirmations is proven by the packed browser gate,
`pnpm test:ui` ([development checks](../../docs/development.md)); run it in
Chromium and WebKit before handoff.
