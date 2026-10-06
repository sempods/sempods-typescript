import { createRoot } from 'react-dom/client';
import { createBrowserRuntime } from '@sempods/app-sdk';
import { UpdateNotice } from '@sempods/app-sdk/react';
import { TodoApp } from './examples/todo/src/app.js';

// Existing AppShell usage, deliberately without any app stylesheet.
const runtime = createBrowserRuntime({
  identity: {
    kind: 'dynamic',
    name: 'SDK styling baseline',
    redirectUri: location.origin + '/baseline/callback',
  },
  returnTo: '/baseline',
  development: 'loopback-http',
});
createRoot(document.getElementById('root')!).render(
  <TodoApp runtime={runtime} legacy>
    <UpdateNotice
      outcome={{ kind: 'unconfirmed' }}
      current={{ title: 'Long comparison text '.repeat(15) }}
      onCheck={async () => true}
      onAcknowledge={() => {}}
    />
  </TodoApp>,
);
window.addEventListener('pagehide', () => runtime.dispose());
