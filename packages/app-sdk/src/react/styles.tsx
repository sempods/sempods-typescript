/** Internal shared baseline. Public tokens inherit from the host; no style registry.
 * Without them, the fallbacks are a calm neutral grey palette. */
export function SdkStyles() {
  return (
    <style href="sempods-sdk" precedence="sempods">
      {styles}
    </style>
  );
}
const surfaces =
  ':where([data-sempods-ui="access"], [data-sempods-ui="editor"], [data-sempods-ui="notice"])';
const styles = `
:where([data-sempods-ui]) {
  --sp-bg:var(--sempods-bg,light-dark(#fff,#111315));
  --sp-text:var(--sempods-text,light-dark(#1f2933,#e5e7eb));
  --sp-muted:var(--sempods-muted,light-dark(#6b7280,#9ca3af));
  --sp-line:var(--sempods-line,light-dark(#e5e7eb,#2d3138));
  --sp-accent:var(--sempods-accent,light-dark(#1f2933,#e5e7eb));
  --sp-on-accent:var(--sempods-on-accent,light-dark(#fff,#111315));
  color:var(--sp-text); font:400 1rem/1.5 system-ui,sans-serif; overflow-wrap:anywhere;
}
:where([data-sempods-ui="access"]) { background:var(--sp-bg); }
${surfaces} :where(.sp-sdk-actions) { display:flex; flex-wrap:wrap; gap:8px; }
${surfaces}, ${surfaces} * { box-sizing:border-box; }
${surfaces} :where(button,input,select,textarea) { font:inherit; max-width:100%; min-width:0; min-height:44px; }
${surfaces} :where(button) { font-weight:500; border:1px solid var(--sp-line); border-radius:5px; color:var(--sp-accent); background:var(--sp-bg); padding:10px 14px; cursor:pointer; }
${surfaces} :where(input,select,textarea) { color:var(--sp-text); background:var(--sp-bg); border:1px solid var(--sp-line); border-radius:4px; padding:10px; }
${surfaces} :where(input:not([type=checkbox]):not([type=radio]),select,textarea) { display:block; width:100%; margin-block:6px 14px; }
${surfaces} :where(input[type=checkbox],input[type=radio]) { width:24px; height:24px; min-height:24px; flex:none; vertical-align:middle; margin:0; margin-inline-end:10px; accent-color:var(--sp-accent); }
${surfaces} :where(label):has(input[type=checkbox],input[type=radio]) { display:inline-flex; align-items:center; min-height:44px; min-width:44px; cursor:pointer; }
${surfaces} :where(:disabled) { opacity:.55; cursor:default; }
${surfaces} :where(:focus-visible) { outline:2px solid var(--sp-accent); outline-offset:3px; }
${surfaces} :where(p) { margin-block:12px; }
${surfaces} :where(dl) { display:grid; gap:12px; margin:12px 0; }
${surfaces} :where(dt) { color:var(--sp-muted); font-size:.875rem; }
${surfaces} :where(dd) { margin:0; white-space:pre-wrap; }
${surfaces} :where(details) { color:var(--sp-muted); font-size:.875rem; margin-block:12px; }
${surfaces} :where(summary) { min-height:44px; padding-block:10px; cursor:pointer; }
:where([data-sempods-ui="notice"]) { margin-block:12px; }
:where([data-sempods-ui="notice"][role=alert]) { border-inline-start:2px solid var(--sp-accent); padding-inline-start:12px; }
:where([data-sempods-ui="editor"]) { margin-block:16px; }
:where([data-sempods-ui="editor"]) > :where(section) { border-block:1px solid var(--sp-line); padding-block:12px; margin-block:16px; }
:where([data-sempods-ui="editor"]) :where(h3) { font-size:1rem; font-weight:600; margin-block:16px 8px; }
:where([data-sempods-ui="editor"]) > :where(section) > :where(button) { margin-block:4px; }
`;
