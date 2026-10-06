import { Fragment, StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRuntime } from '@sempods/app-sdk';
import {
  AppAccess,
  SempodsProvider,
  useAppState,
  useSdkLocale,
} from '@sempods/app-sdk/react';
// Installed from its own tarball by the consumer test, not a workspace alias.
import { QuickAddWidget, TaskListWidget } from '@sempods/example-widgets';

const podUrl = location.origin + '/widgets-pod';
const runtime = createBrowserRuntime({
  identity: {
    kind: 'dynamic',
    name: 'Widget host',
    redirectUri: location.origin + '/callback?identity=widgets',
  },
  preset: { podUrl, contextIri: podUrl + '/_system/contexts/work' },
  allowedPods: [podUrl],
  returnTo: '/app?identity=widgets',
  development: 'loopback-http',
});
window.addEventListener('pagehide', () => runtime.dispose());
function Host() {
  const state = useAppState();
  const { messages: m } = useSdkLocale();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState(true);
  const [fallback, setFallback] = useState<'hidden' | 'disabled' | 'custom'>(
    'hidden',
  );
  const presentation =
    fallback === 'custom'
      ? { content: <p>Ask the host for access.</p> }
      : fallback;
  return (
    <main style={{ maxWidth: 640, margin: 'auto', padding: 12 }}>
      {state.view && <h1>My dashboard</h1>}
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        {m.controls.dataAccess}
      </button>
      <AppAccess
        appName="My dashboard"
        open={open}
        podNames={{ [podUrl]: 'My Pod' }}
      />
      <output aria-label="Connections">{state.connections.length}</output>
      <label>
        Fallback
        <select
          aria-label="Fallback"
          value={fallback}
          onChange={(e) => setFallback(e.target.value as typeof fallback)}
        >
          <option>hidden</option>
          <option>disabled</option>
          <option>custom</option>
        </select>
      </label>
      <button onClick={() => setList(!list)}>Toggle list widget</button>
      <Fragment key={state.view?.key ?? 'no-target'}>
        {list && <TaskListWidget fallback={presentation} />}
        <QuickAddWidget fallback={presentation} />
      </Fragment>
    </main>
  );
}
const root = createRoot(document.getElementById('app')!);
function Scene() {
  const [language, setLanguage] = useState<'en' | 'de'>('en');
  return (
    <>
      <button onClick={() => setLanguage(language === 'en' ? 'de' : 'en')}>
        EN/DE
      </button>
      <SempodsProvider runtime={runtime} language={language}>
        <Host />
      </SempodsProvider>
    </>
  );
}
function render() {
  root.render(
    <StrictMode>
      <Scene />
    </StrictMode>,
  );
}
render();
// Test controls exercise host lifecycle explicitly, never widget-owned disposal.
Object.assign(window, {
  widgetHost: {
    runtime,
    unmount: () => root.render(null),
    remount: render,
    dispose: () => {
      root.unmount();
      runtime.dispose();
    },
  },
});
