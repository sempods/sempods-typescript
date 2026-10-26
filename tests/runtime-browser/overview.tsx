import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRuntime } from '@sempods/app-sdk';
import { PodOverviewExample } from './pod-overview.js';
import { OverviewToggleExample } from './overview-toggle.js';
import { TaskWithNoteExample } from './task-with-note.js';

// `expiring` runs the same recipe against a Pod issuing short-lived tokens;
// `toggle` runs the one-click recipe, `split` the task-with-note recipe.
const requested = new URL(location.href).searchParams.get('identity');
const identity =
  requested === 'expiring' || requested === 'toggle' || requested === 'split'
    ? requested
    : 'overview';
const contexts = location.origin + '/split-pod/_system/contexts/';
const runtime = createBrowserRuntime({
  identity: {
    kind: 'dynamic',
    name: 'Pod overview',
    redirectUri: location.origin + '/callback?identity=' + identity,
  },
  preset: {
    podUrl: location.origin + '/' + identity + '-pod',
  },
  returnTo: '/app?identity=' + identity,
  development: 'loopback-http',
});
window.addEventListener('pagehide', () => runtime.dispose());
createRoot(document.getElementById('app')!).render(
  <StrictMode>
    {identity === 'toggle' ? (
      <OverviewToggleExample runtime={runtime} />
    ) : identity === 'split' ? (
      <TaskWithNoteExample
        runtime={runtime}
        shared={contexts + 'work'}
        personal={contexts + 'notes'}
      />
    ) : (
      <PodOverviewExample runtime={runtime} />
    )}
  </StrictMode>,
);
