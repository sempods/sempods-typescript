import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRuntime } from '@sempods/app-sdk';
import { PodOverviewExample } from './pod-overview.js';

const runtime = createBrowserRuntime({
  identity: {
    kind: 'dynamic',
    name: 'Pod overview',
    redirectUri: location.origin + '/callback?identity=overview',
  },
  preset: { podUrl: location.origin + '/overview-pod' },
  returnTo: '/app?identity=overview',
  development: 'loopback-http',
});
window.addEventListener('pagehide', () => runtime.dispose());
createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <PodOverviewExample runtime={runtime} />
  </StrictMode>,
);
