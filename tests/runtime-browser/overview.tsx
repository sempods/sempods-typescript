import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRuntime } from '@sempods/app-sdk';
import { PodOverviewExample } from './pod-overview.js';

// `expiring` runs the same recipe against a Pod issuing short-lived tokens.
const identity =
  new URL(location.href).searchParams.get('identity') === 'expiring'
    ? 'expiring'
    : 'overview';
const runtime = createBrowserRuntime({
  identity: {
    kind: 'dynamic',
    name: 'Pod overview',
    redirectUri: location.origin + '/callback?identity=' + identity,
  },
  preset: {
    podUrl:
      location.origin +
      (identity === 'expiring' ? '/expiring-pod' : '/overview-pod'),
  },
  returnTo: '/app?identity=' + identity,
  development: 'loopback-http',
});
window.addEventListener('pagehide', () => runtime.dispose());
createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <PodOverviewExample runtime={runtime} />
  </StrictMode>,
);
