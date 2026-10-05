import { createRoot } from 'react-dom/client';
import { createBrowserRuntime } from '@sempods/app-sdk';
import { fields, text } from '@sempods/client-sdk/edit';
import {
  AppShell,
  SempodsProvider,
  TargetScreen,
  UpdateNotice,
  useAppState,
  useCreation,
  useWorkflowAccess,
} from '@sempods/app-sdk/react';

const podUrl = location.origin + '/alice';
const runtime = createBrowserRuntime({
  identity: {
    kind: 'dynamic',
    name: 'Preset consumer',
    redirectUri: location.origin + '/callback?identity=preset',
  },
  preset: { podUrl, contextIri: podUrl + '/_system/contexts/work' },
  scopes: { required: ['tasks'], optional: ['ai'] },
  development: 'loopback-http',
  returnTo: '/app?identity=preset',
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
  return (
    <>
      <output aria-label="Connections">{state.connections.length}</output>
      <output aria-label="Selected context">
        {state.view?.contextIri ?? ''}
      </output>
      <AppShell title="Known Pod" mode="single">
        <TargetScreen>
          <Draft />
        </TargetScreen>
      </AppShell>
    </>
  );
}
createRoot(document.getElementById('app')!).render(
  <SempodsProvider runtime={runtime}>
    <Evidence />
  </SempodsProvider>,
);
