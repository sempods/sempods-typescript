import { useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRuntime } from '@sempods/app-sdk';
import {
  AppAccess,
  ResourceEditor,
  SempodsProvider,
  TargetScreen,
  useApp,
  useAppState,
  useDraftGuard,
  useList,
  useResourceEditor,
  useSelection,
  useSdkLocale,
} from '@sempods/app-sdk/react';
import { taskFields } from './examples/todo/src/domain.js';
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
/** Exercises selection and controller-owned editor retention in a packed consumer. */
function EditorProbe() {
  const list = useList(taskFields);
  const item = list.data?.items[0];
  const { selected, select } = useSelection();
  const editor = useResourceEditor(selected, taskFields);
  return (
    <>
      <button
        disabled={!item}
        onClick={() => {
          if (item) void select(item.iri);
        }}
      >
        Open test editor
      </button>
      {selected && (
        <ResourceEditor editor={editor} onClose={() => select(null)}>
          {(draft, change) => (
            <input
              aria-label="Retained editor draft"
              value={draft.title}
              onChange={(event) => change({ title: event.target.value })}
            />
          )}
        </ResourceEditor>
      )}
    </>
  );
}
function RemountProbe() {
  const [mounted, setMounted] = useState(true);
  return (
    <>
      <button onClick={() => setMounted(!mounted)}>
        {mounted ? 'Unmount test screen' : 'Mount test screen'}
      </button>
      <TargetScreen>{mounted && <EditorProbe />}</TargetScreen>
    </>
  );
}
/** The standard composition with a replacement connection view. */
function Shell({ children }: { readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { messages } = useSdkLocale();
  return (
    <main>
      <header>
        <button aria-expanded={open} onClick={() => setOpen(!open)}>
          {messages.controls.dataAccess}
        </button>
      </header>
      <AppAccess
        appName="sempods TODO"
        open={open}
        components={{ Connections: Picker }}
      />
      {children}
    </main>
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
      <Shell>
        <Draft />
        <RemountProbe />
      </Shell>
    </SempodsProvider>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
