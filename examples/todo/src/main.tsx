import { createRoot } from 'react-dom/client';
import { createBrowserRuntime } from '@sempods/app-sdk';
import { TodoApp } from './app.js';
import './style.css';

function mount() {
  const runtime = createBrowserRuntime({
    identity: {
      kind: 'dynamic',
      name: 'sempods TODO',
      redirectUri: location.origin + '/callback',
    },
    returnTo: '/',
    development: 'loopback-http',
  });
  const root = createRoot(document.getElementById('root')!);
  root.render(<TodoApp runtime={runtime} />);
  return () => {
    root.unmount();
    runtime.dispose();
  };
}

let dispose = mount();
window.addEventListener('pagehide', () => dispose());
// BFCache restores this module without executing it again. The old runtime
// was disposed to release its session lease; startup must own a fresh one.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) dispose = mount();
});
