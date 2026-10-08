import { createRoot } from 'react-dom/client';
import { useRef, useState } from 'react';
import { createBrowserRuntime } from '@sempods/app-sdk';
import { fields, text } from '@sempods/client-sdk/edit';
import {
  AppShell,
  AppAccess,
  SempodsProvider,
  TargetScreen,
  UpdateNotice,
  useAppState,
  useCreation,
  useWorkflowAccess,
} from '@sempods/app-sdk/react';

const podUrl = location.origin + '/alice';
const identity =
  new URL(location.href).searchParams.get('identity') ?? 'preset';
const accessUI = identity.startsWith('access-');
const language = identity.endsWith('-de') ? 'de' : 'en';
const runtime = createBrowserRuntime({
  identity: {
    kind: 'dynamic',
    name: 'Preset consumer',
    redirectUri: location.origin + '/callback?identity=' + identity,
  },
  ...(!accessUI
    ? { preset: { podUrl, contextIri: podUrl + '/_system/contexts/work' } }
    : {}),
  ...(identity === 'access-one'
    ? { allowedPods: [podUrl] }
    : identity === 'access-set'
      ? { allowedPods: [podUrl, location.origin + '/bob'] }
      : identity === 'access-delayed'
        ? { allowedPods: [location.origin + '/delayed'] }
        : {}),
  scopes: { required: ['tasks'], optional: ['ai'] },
  development: 'loopback-http',
  returnTo: '/app?identity=' + identity,
});
window.addEventListener('pagehide', () => runtime.dispose());
const task = fields({
  title: text('https://schema.org/name', { language: null }),
});
function Draft() {
  const creation = useCreation(task, {
    initial: { title: '' },
    collection: 'tasks',
  });
  const access = useWorkflowAccess();
  return (
    <>
      <input
        aria-label="Preset draft"
        disabled={!access.write || !creation.canEdit}
        value={creation.draft.title}
        onChange={(e) => creation.change({ title: e.target.value })}
      />
      <UpdateNotice {...creation.notice} />
    </>
  );
}
function Evidence() {
  const state = useAppState();
  const [open, setOpen] = useState(false);
  const target = useRef<HTMLButtonElement>(null);
  return (
    <>
      <div hidden>
        <output aria-label="Connections">{state.connections.length}</output>
        <output aria-label="Selected context">
          {state.view?.contextIri ?? ''}
        </output>
      </div>
      {accessUI ? (
        <>
          {state.connections.length > 0 && (
            <button
              ref={target}
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              Data access
            </button>
          )}
          <AppAccess
            appName="Shopping"
            icon={<span>✓</span>}
            podNames={{
              [podUrl]: 'Personal',
              [location.origin + '/bob']: 'Team',
            }}
            open={open}
            focusTarget={target}
          />
          <TargetScreen>
            <Draft />
          </TargetScreen>
        </>
      ) : (
        <AppShell title="Known Pod" mode="single">
          <TargetScreen>
            <Draft />
          </TargetScreen>
        </AppShell>
      )}
    </>
  );
}
// Every state the access surface passes through on this page load, recorded
// from before the first render so a brief flash cannot slip between polls.
const accessTrace: string[] = [];
Object.assign(window, { accessTrace });
new MutationObserver(() => {
  const section = document.querySelector('[data-sempods-access]');
  if (!section) return;
  const state = section.hasAttribute('hidden')
    ? 'hidden'
    : section.textContent?.includes('Full addresses')
      ? 'connection'
      : section.querySelector('[role="status"]')?.textContent === 'Loading…'
        ? 'loading'
        : 'other';
  if (accessTrace.at(-1) !== state) accessTrace.push(state);
}).observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  characterData: true,
});
createRoot(document.getElementById('app')!).render(
  identity === 'access-delayed' ? (
    // A Pod overview fixed to one Pod, without a Context flow.
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <AppAccess appName="Shopping" />
    </SempodsProvider>
  ) : (
    <SempodsProvider runtime={runtime} language={language}>
      <Evidence />
    </SempodsProvider>
  ),
);
