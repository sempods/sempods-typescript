/** Internal shared baseline. Public tokens inherit from the host; no style registry.
 * Without them, the fallbacks are a calm neutral grey palette. Actions read as
 * text, as in AppAccess; the one main action of a surface is filled. */
export function SdkStyles() {
  return (
    <style href="sempods-sdk" precedence="sempods">
      {layered(styles)}
    </style>
  );
}

/**
 * Internal: puts an SDK sheet into the `sempods` cascade layer. React inserts
 * the first hoisted sheet at the start of the head, so this statement usually
 * fixes the page's layer order: `sempods` above a reset in `base` (Tailwind's
 * preflight) and below every layer declared later, such as Tailwind's
 * `components` and `utilities`. Unlayered host rules win over all of it.
 */
export function layered(css: string): string {
  return `@layer base, sempods;\n@layer sempods {${css}}\n`;
}
const surfaces =
  ':where([data-sempods-ui="access"], [data-sempods-ui="editor"], [data-sempods-ui="notice"], .sp-sdk-dialog)';
const styles = `
:where([data-sempods-ui]) {
  --sp-bg:var(--sempods-bg,light-dark(#fff,#111315));
  --sp-text:var(--sempods-text,light-dark(#1f2933,#e5e7eb));
  --sp-muted:var(--sempods-muted,light-dark(#6b7280,#9ca3af));
  --sp-line:var(--sempods-line,light-dark(#e5e7eb,#2d3138));
  --sp-accent:var(--sempods-accent,light-dark(#1f2933,#e5e7eb));
  --sp-on-accent:var(--sempods-on-accent,light-dark(#fff,#111315));
  --sp-field-line:var(--sempods-field-line,var(--sp-line));
  --sp-primary-bg:var(--sempods-primary-bg,var(--sp-accent));
  --sp-primary-text:var(--sempods-primary-text,var(--sp-on-accent));
  --sp-secondary-text:var(--sempods-secondary-text,var(--sp-accent));
  --sp-focus:var(--sempods-focus,var(--sp-accent));
  --sp-font:var(--sempods-font,system-ui,sans-serif);
  --sp-radius:var(--sempods-radius,8px);
  color:var(--sp-text); font:400 1rem/1.5 var(--sp-font); overflow-wrap:anywhere;
}
:where([data-sempods-ui="access"]) { background:var(--sp-bg); }
${surfaces} :where(.sp-sdk-actions) { display:flex; flex-wrap:wrap; gap:8px; }
${surfaces} :where(.sp-sdk-end) { margin-inline-start:auto; }
${surfaces}, ${surfaces} * { box-sizing:border-box; }
${surfaces} :where(button,input,select,textarea) { font:inherit; max-width:100%; min-width:0; min-height:44px; }
${surfaces} :where(button) { font-weight:500; border:0; border-radius:var(--sp-radius); color:var(--sp-secondary-text); background:transparent; padding:10px 14px; cursor:pointer; }
${surfaces} :where(button:hover:not(:disabled)) { background:color-mix(in srgb,var(--sp-secondary-text) 8%,transparent); }
${surfaces} :where(button.sp-sdk-primary) { color:var(--sp-primary-text); background:var(--sp-primary-bg); }
${surfaces} :where(input,select,textarea) { color:var(--sp-text); background:var(--sp-bg); border:1px solid var(--sp-field-line); border-radius:var(--sp-radius); padding:10px 12px; }
${surfaces} :where(input:not([type=checkbox]):not([type=radio]),select,textarea) { display:block; width:100%; margin-block:6px 14px; }
${surfaces} :where(input[type=checkbox],input[type=radio]) { width:24px; height:24px; min-height:24px; flex:none; vertical-align:middle; margin:0; margin-inline-end:10px; accent-color:var(--sp-accent); }
${surfaces} :where(label):has(input[type=checkbox],input[type=radio]) { display:inline-flex; align-items:center; min-height:44px; min-width:44px; cursor:pointer; }
${surfaces} :where(:disabled) { opacity:.55; cursor:default; }
${surfaces} :where(:focus-visible) { outline:2px solid var(--sp-focus); outline-offset:3px; }
${surfaces} :where(input:not([type=checkbox]):not([type=radio]),select,textarea):where(:focus-visible) { outline-offset:-1px; }
${surfaces} :where(p) { margin-block:12px; }
${surfaces} :where(dl) { display:grid; gap:12px; margin:12px 0; }
${surfaces} :where(dt) { color:var(--sp-muted); font-size:.875rem; }
${surfaces} :where(dd) { margin:0; white-space:pre-wrap; }
${surfaces} :where(details) { color:var(--sp-muted); font-size:.875rem; margin-block:12px; }
${surfaces} :where(summary) { min-height:44px; padding-block:10px; cursor:pointer; }
/* Explicit, so a reset such as Tailwind's preflight (margin:0) keeps modals centred. */
:where(.sp-sdk-dialog) { margin:auto; background:var(--sp-bg); border:0; border-radius:calc(var(--sp-radius) * 1.5); padding:24px; max-width:min(420px,calc(100vw - 32px)); box-shadow:0 12px 32px rgb(0 0 0 / .2); }
:where(.sp-sdk-dialog)::backdrop { background:rgb(0 0 0 / .45); }
:where(.sp-sdk-dialog) :where(h2) { font-size:1.25rem; font-weight:600; margin:0 0 8px; }
:where(.sp-sdk-dialog) :where(.sp-sdk-actions) { justify-content:flex-end; margin-top:20px; }
:where([data-sempods-ui="notice"]) { margin-block:12px; }
:where([data-sempods-ui="notice"][role=alert]) { border-inline-start:2px solid var(--sp-accent); padding-inline-start:12px; }
:where([data-sempods-ui="editor"]) { margin-block:16px; }
:where([data-sempods-ui="editor"]) :where(.sp-sdk-end) { color:var(--sp-muted); }
:where([data-sempods-ui="editor"][data-inline]) { margin-block:4px; padding:8px; border-radius:calc(var(--sp-radius) * 1.5); background:color-mix(in srgb,var(--sp-accent) 5%,transparent); }
:where([data-sempods-ui="editor"][data-inline]) :where(input:not([type=checkbox]):not([type=radio]),select,textarea) { margin-block:0 8px; }
:where([data-sempods-ui="editor"][data-presentation="plain"]) { margin-block:0; }
:where([data-sempods-ui="editor"][data-presentation="plain"]) > :where(fieldset) { display:grid; gap:12px; min-inline-size:0; }
:where([data-sempods-ui="editor"][data-presentation="plain"]) :where(input:not([type=checkbox]):not([type=radio]),select,textarea) { margin-block:6px 0; }
:where([data-sempods-ui="editor"][data-presentation="plain"]) > :where(.sp-sdk-actions) { margin-block-start:24px; }
:where([data-sempods-ui="editor"]) > :where(section) { border-block:1px solid var(--sp-line); padding-block:12px; margin-block:16px; }
:where([data-sempods-ui="editor"]) :where(h3) { font-size:1rem; font-weight:600; margin-block:16px 8px; }
:where([data-sempods-ui="editor"]) > :where(section) > :where(button) { margin-block:4px; }
:where([data-sempods-ui="remove-button"]) { display:inline-grid; place-items:center; flex:none; box-sizing:border-box; min-width:44px; min-height:44px; padding:0 10px; border:0; border-radius:calc(var(--sp-radius) * 2.75); color:var(--sp-muted); background:transparent; font-weight:500; cursor:pointer; }
:where([data-sempods-ui="remove-button"]:hover:not(:disabled)) { color:var(--sp-text); background:color-mix(in srgb,var(--sp-accent) 8%,transparent); }
:where([data-sempods-ui="remove-button"]:disabled) { opacity:.55; cursor:default; }
:where([data-sempods-ui="remove-button"]:focus-visible) { outline:2px solid var(--sp-focus); outline-offset:3px; }
:where([data-sempods-ui="remove-button"]) :where(svg) { width:20px; height:20px; }
`;
