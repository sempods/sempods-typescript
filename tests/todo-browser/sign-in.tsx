import { useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRuntime } from '@sempods/app-sdk';
import { KnownPodExample } from './examples/todo/recipes/sign-in.js';

// Copied outside the workspace by the packed-consumer harness.
const runtime = createBrowserRuntime({
  identity: {
    kind: 'dynamic',
    name: 'Known Pod example',
    redirectUri: location.origin + '/recipe/callback',
  },
  returnTo: '/recipe',
  development: 'loopback-http',
});
window.addEventListener('pagehide', () => runtime.dispose());
function App() {
  const connections = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
  );
  const [language, setLanguage] = useState<'en' | 'de'>('en');
  const [fallback, setFallback] = useState<'hidden' | 'disabled' | 'custom'>(
    'hidden',
  );
  return (
    <>
      <output aria-label="Connections">{connections.length}</output>
      <button onClick={() => setLanguage(language === 'en' ? 'de' : 'en')}>
        EN/DE
      </button>
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
      <KnownPodExample
        runtime={runtime}
        podUrl={location.origin + '/alice'}
        language={language}
        fallback={
          fallback === 'custom'
            ? { content: <p>Contact the host for access.</p> }
            : fallback
        }
      />
    </>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
