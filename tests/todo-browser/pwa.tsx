import { createRoot } from 'react-dom/client';
import { createBrowserRuntime } from '@sempods/app-sdk';
import { TodoApp } from './examples/todo/src/app.js';
import {
  NewVersionNotice,
  registerAppWorker,
} from './examples/todo/pwa/register.js';
import './examples/todo/src/style.css';

// Copied outside the workspace by the packed-consumer harness: the TODO app
// served as an installable PWA with the recipe's service worker.
const runtime = createBrowserRuntime({
  identity: {
    kind: 'dynamic',
    name: 'sempods TODO',
    redirectUri: location.origin + '/callback',
  },
  returnTo: '/',
  development: 'loopback-http',
});
const registration = registerAppWorker('/sw.js');
createRoot(document.getElementById('root')!).render(
  <TodoApp runtime={runtime}>
    <NewVersionNotice registration={registration} />
  </TodoApp>,
);
window.addEventListener('pagehide', () => runtime.dispose());
