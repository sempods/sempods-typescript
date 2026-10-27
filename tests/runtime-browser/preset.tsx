import { createRoot } from 'react-dom/client';
import { useRef, useState } from 'react';
import { createBrowserRuntime } from '@sempods/app-sdk';
import { fields, text } from '@sempods/client-sdk/edit';
import {
  AppAccess,
  ResourceEditor,
  SempodsProvider,
  TargetScreen,
  UpdateNotice,
  useAppState,
  useCreation,
  useResourceEditor,
  useWorkflowAccess,
} from '@sempods/app-sdk/react';

const podUrl = location.origin + '/alice';
const identity =
  new URL(location.href).searchParams.get('identity') ?? 'preset';
const accessUI = identity.startsWith('access-');
const signOutUI = identity.startsWith('signout-');
// Management and an editor inside the app's own modal dialog.
const modal = identity === 'access-modal';
const language = identity.endsWith('-de') ? 'de' : 'en';
// A Pod whose Context catalogue answers after a delay, with a Context flow.
const slowCatalogue = location.origin + '/slowcat';
const catalogueUI = identity.startsWith('access-catalogue-');
const runtime = createBrowserRuntime({
  identity: {
    kind: 'dynamic',
    name: 'Preset consumer',
    redirectUri: location.origin + '/callback?identity=' + identity,
  },
  ...(!accessUI || modal
    ? { preset: { podUrl, contextIri: podUrl + '/_system/contexts/work' } }
    : catalogueUI && identity !== 'access-catalogue-choice'
      ? {
          preset: {
            podUrl: slowCatalogue,
            contextIri: slowCatalogue + '/_system/contexts/work',
          },
        }
      : {}),
  ...(identity === 'access-one' || identity.startsWith('access-focus-')
    ? { allowedPods: [podUrl] }
    : identity === 'access-set'
      ? { allowedPods: [podUrl, location.origin + '/bob'] }
      : identity === 'access-delayed'
        ? { allowedPods: [location.origin + '/delayed'] }
        : identity === 'access-catalogue-choice'
          ? { allowedPods: [slowCatalogue] }
          : {}),
  scopes: { required: ['tasks'], optional: ['ai'] },
  development: 'loopback-http',
  // The address when a sign-in starts, so an in-app deep link survives it.
  returnTo: () => location.pathname + location.search + location.hash,
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
function KnownIri() {
  const creation = useCreation(task, {
    initial: { title: '' },
    iri: 'urn:packed-settings',
  });
  return (
    <>
      <input
        aria-label="Settings title"
        value={creation.draft.title}
        disabled={!creation.canEdit}
        onChange={(event) => creation.change({ title: event.target.value })}
      />
      <button
        disabled={!creation.canCreate}
        onClick={() => void creation.create()}
      >
        Create settings
      </button>
      <output aria-label="Settings outcome">{creation.outcome?.kind}</output>
      <UpdateNotice {...creation.notice} />
    </>
  );
}
const named = fields({
  title: text('https://schema.org/name', { language: 'en' }),
});
function ModalEvidence() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const editor = useResourceEditor(open ? 'urn:fixture-task' : null, named);
  return (
    <>
      <AppAccess appName="Shopping" description="Shopping made easy" />
      <TargetScreen>
        <button
          onClick={() => {
            setOpen(true);
            dialog.current?.showModal();
          }}
        >
          Manage
        </button>
      </TargetScreen>
      <dialog ref={dialog} aria-label="Manage" onClose={() => setOpen(false)}>
        <AppAccess appName="Shopping" open={open} headingLevel={2} />
        <ResourceEditor editor={editor}>
          {(draft, change) => (
            <input
              aria-label="Task title"
              value={draft.title ?? ''}
              onChange={(e) => change({ title: e.target.value })}
            />
          )}
        </ResourceEditor>
        <button onClick={() => dialog.current?.close()}>Close</button>
      </dialog>
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
        <output aria-label="Sign-out failure">
          {state.connections.some(
            (c) => c.session.kind === 'ended' && c.session.saved === false,
          )
            ? 'failed'
            : ''}
        </output>
      </div>
      {signOutUI ? (
        <AppAccess
          appName="Sign-out fixture"
          open={state.connections.length > 0}
        />
      ) : modal ? (
        <ModalEvidence />
      ) : accessUI ? (
        <>
          {state.connections.length > 0 && (
            <button
              ref={target}
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              Pods & sharing
            </button>
          )}
          <AppAccess
            appName="Shopping"
            icon={<span>✓</span>}
            podAddress="hidden"
            podNames={{
              [podUrl]: 'Personal',
              [location.origin + '/bob']: 'Team',
            }}
            open={open}
            focusTarget={target}
          />
          <TargetScreen>
            <Draft />
            {identity === 'preset' && <KnownIri />}
          </TargetScreen>
        </>
      ) : (
        <>
          <h1>Known Pod</h1>
          {state.connections.length > 0 && (
            <button
              ref={target}
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              Pods & sharing
            </button>
          )}
          <AppAccess
            appName="Known Pod"
            headingLevel={2}
            mode="single"
            open={open}
            focusTarget={target}
          />
          <TargetScreen>
            <Draft />
            {identity === 'preset' && <KnownIri />}
          </TargetScreen>
        </>
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
  catalogueUI ? (
    <SempodsProvider
      runtime={runtime}
      contextSelection={
        identity === 'access-catalogue-on-demand' ? 'on-demand' : 'required'
      }
    >
      <AppAccess appName="Shopping" />
      <TargetScreen>
        <p>Context screen</p>
      </TargetScreen>
    </SempodsProvider>
  ) : identity === 'access-delayed' ? (
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
