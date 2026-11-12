import { useState } from 'react';
import {
  AppAccess,
  useApp,
  useAppState,
  useDraftGuard,
} from '@sempods/app-sdk/react';
import { ContextSwitch } from '@sempods/app-ui';

// Only fixture controls live here: the chooser itself comes from the tarball.
export function ContextSwitchGate() {
  const actions = useApp();
  const state = useAppState();
  const [dirty, setDirty] = useState(false);
  useDraftGuard(dirty, () => setDirty(false));
  return (
    <main className="p-4">
      <ContextSwitch
        title="Groceries"
        label="List"
        icon={<span>K</span>}
        podNames={{
          [location.origin + '/alice']: 'Privat',
          [location.origin + '/bob']: 'Familie/',
        }}
      />
      <AppAccess appName="Groceries" />
      <button onClick={() => void actions.connect(location.origin + '/bob')}>
        Connect second Pod
      </button>
      <button onClick={() => setDirty(true)}>Keep a draft</button>
      <button
        onClick={() => {
          const pod = state.connections.find((c) => c.podUrl.endsWith('/bob'));
          if (pod) void actions.refreshContexts(pod.id).catch(() => {});
        }}
      >
        Reload second Pod
      </button>
      <output aria-label="draft">{dirty ? 'dirty' : 'clean'}</output>
      <output aria-label="target">
        {
          state.connections.find((c) => c.id === state.activeId)
            ?.selectedContext
        }
      </output>
    </main>
  );
}
