/** Internal shared baseline. Public tokens inherit from the host; no style registry. */
export function SdkStyles() {
  return (
    <style href="sempods-sdk" precedence="sempods">
      {styles}
    </style>
  );
}
const surfaces =
  ':where([data-sempods-ui="access"], [data-sempods-ui="connections"], [data-sempods-ui="editor"], [data-sempods-ui="notice"])';
const styles = `
:where([data-sempods-ui]) {
  --sp-bg:var(--sempods-bg,var(--sempods-access-bg,light-dark(#fff,#191b1a)));
  --sp-text:var(--sempods-text,var(--sempods-access-text,light-dark(#202923,#e8eee9)));
  --sp-muted:var(--sempods-muted,var(--sempods-access-muted,light-dark(#606c64,#acb9b0)));
  --sp-line:var(--sempods-line,var(--sempods-access-line,light-dark(#dce3dd,#39453d)));
  --sp-accent:var(--sempods-accent,var(--sempods-access-accent,light-dark(#226044,#8acda6)));
  --sp-on-accent:var(--sempods-on-accent,var(--sempods-access-on-accent,light-dark(#fff,#14251b)));
  color:var(--sp-text); font:400 1rem/1.5 system-ui,sans-serif; overflow-wrap:anywhere;
}
:where([data-sempods-ui="shell"], [data-sempods-ui="access"]) { background:var(--sp-bg); }
${surfaces} :where(.sp-sdk-actions) { display:flex; flex-wrap:wrap; gap:8px; }
${surfaces}, ${surfaces} * { box-sizing:border-box; }
${surfaces} :where(button,input,select,textarea), :where([data-sempods-button]) { font:inherit; max-width:100%; min-width:0; min-height:44px; }
${surfaces} :where(button), :where([data-sempods-button]) { font-weight:500; border:1px solid var(--sp-line); border-radius:5px; color:var(--sp-accent); background:var(--sp-bg); padding:10px 14px; cursor:pointer; }
${surfaces} :where(input,select,textarea) { color:var(--sp-text); background:var(--sp-bg); border:1px solid var(--sp-line); border-radius:4px; padding:10px; }
${surfaces} :where(input:not([type=checkbox]):not([type=radio]),select,textarea) { display:block; width:100%; margin-block:6px 14px; }
${surfaces} :where(input[type=checkbox],input[type=radio]) { width:44px; height:44px; min-height:44px; vertical-align:middle; margin:0 8px 0 0; accent-color:var(--sp-accent); }
${surfaces} :where(label):has(input[type=checkbox],input[type=radio]) { display:inline-flex; align-items:center; min-height:44px; }
${surfaces} :where(:disabled), :where([data-sempods-button]:disabled) { opacity:.55; cursor:default; }
${surfaces} :where(:focus-visible), :where([data-sempods-button]:focus-visible) { outline:2px solid var(--sp-accent); outline-offset:3px; }
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
:where([data-sempods-ui="shell"]) { max-width:900px; margin-inline:auto; padding:clamp(12px,4vw,32px); }
:where([data-sempods-ui="shell"]) > header { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; margin-bottom:16px; }
:where([data-sempods-ui="shell"]) > header > h1 { font-size:1.75rem; font-weight:500; line-height:1.25; margin:0; }
`;
