import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRuntime } from '@sempods/app-sdk';
import {
  AppShell,
  SempodsProvider,
  useApp,
  useAppState,
  useDraftGuard,
  useSdkLocale,
} from '@sempods/app-sdk/react';
const runtime = createBrowserRuntime({
  identity: {
    kind: 'dynamic',
    name: 'sempods TODO',
    redirectUri: location.origin + '/callback',
  },
  returnTo: '/customized',
  development: 'loopback-http',
});
window.addEventListener('pagehide', () => runtime.dispose());
function Picker() {
  const app = useApp();
  const state = useAppState();
  const connection = state.connections.find((c) => c.id === state.activeId);
  if (connection?.catalogue.kind !== 'ready') return null;
  return (
    <aside aria-label="My picker">
      {connection.catalogue.contexts.map((context) => (
        <button
          key={context.iri}
          onClick={() => void app.selectContext(context.iri)}
        >
          Use {context.iri.split('/').at(-1)}
        </button>
      ))}
    </aside>
  );
}
function Draft() {
  const [value, setValue] = useState('');
  const state = useAppState();
  const m = useSdkLocale().messages;
  useDraftGuard(Boolean(value), () => setValue(''));
  return (
    <>
      <input
        aria-label="Custom draft"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <output>{state.view?.contextIri.split('/').at(-1) ?? 'Choose'}</output>
      <p>{m.controls.save}</p>
    </>
  );
}
function App() {
  const [language, setLanguage] = useState<'en' | 'de'>('en');
  return (
    <SempodsProvider
      runtime={runtime}
      language={language}
      messages={{
        controls: {
          save: language === 'en' ? 'Store my task' : 'Aufgabe ablegen',
        },
      }}
    >
      <button onClick={() => setLanguage('de')}>German</button>
      <AppShell components={{ Connections: Picker }}>
        <Draft />
      </AppShell>
    </SempodsProvider>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
