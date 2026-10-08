import { createRoot } from 'react-dom/client';
import { createBrowserRuntime } from '@sempods/app-sdk';
import { TodoApp } from './app.js';
import './style.css';

const url = new URL(location.href);
const runtime = createBrowserRuntime({
  identity: {
    kind: 'dynamic',
    name: 'sempods TODO',
    redirectUri: location.origin + '/callback',
  },
  returnTo: ['/custom', '/legacy'].includes(url.pathname) ? url.pathname : '/',
  development: 'loopback-http',
});
createRoot(document.getElementById('root')!).render(
  <TodoApp runtime={runtime} />,
);

window.addEventListener('pagehide', () => runtime.dispose());
