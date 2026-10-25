import { createRoot } from 'react-dom/client';
import { createBrowserRuntime } from '@sempods/app-sdk';
import { TodoApp } from './app.js';
import './style.css';

const runtime = createBrowserRuntime({
  identity: {
    kind: 'dynamic',
    name: 'sempods TODO',
    redirectUri: location.origin + '/callback',
  },
  // Called when a sign-in starts: return to the screen the person is on.
  returnTo: () =>
    ['/custom', '/legacy'].includes(location.pathname)
      ? location.pathname
      : '/',
  development: 'loopback-http',
});
createRoot(document.getElementById('root')!).render(
  <TodoApp runtime={runtime} />,
);

window.addEventListener('pagehide', () => runtime.dispose());
