import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createAppController, createFormatters } from '@sempods/app-sdk';
import { fields, text } from '@sempods/client-sdk/edit';
import {
  SdkLocaleProvider,
  AccessGate,
  type ConnectionsProps,
  SempodsProvider,
  useSdkLocale,
  useApp,
  useCreation,
  useFieldUpdate,
  useList,
  usePodContexts,
  usePodList,
  usePodLoad,
  type PodContextChoice,
  type PodListSkipped,
} from '@sempods/app-sdk/react';
import type {
  BoundPod,
  BrowserRuntime,
  ContextTarget,
  LoadState,
  LeaveGuard,
  TargetSelection,
} from '@sempods/app-sdk';
import type { SkippedRecord } from '@sempods/client-sdk/edit';
import { ResourceValues } from './node_modules/@sempods/app-sdk/examples/todo/recipes/rdf-value-view.js';

function Task() {
  const [draft, setDraft] = useState('');
  const { messages } = useSdkLocale();
  return (
    <>
      <input
        aria-label="draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <p>{messages.reviewAccess}</p>
    </>
  );
}
function App() {
  const [locale, setLocale] = useState('en-US');
  return (
    <SdkLocaleProvider locale={locale}>
      <Task />
      <button onClick={() => setLocale('de-DE')}>Deutsch</button>
      <output>{createFormatters(locale).number(1234.5)}</output>
    </SdkLocaleProvider>
  );
}
const host = document.getElementById('app');
if (!host) throw new Error('Missing consumer mount point.');
createRoot(host).render(<App />);

// The shipped RDF value recipe (#235) in a real layout: the exact form keeps
// consecutive spaces, which a browser would otherwise collapse.
const values = document.createElement('section');
values.id = 'rdf-values';
document.body.append(values);
createRoot(values).render(
  <SdkLocaleProvider locale="en-US">
    <ResourceValues
      result={{
        variables: ['property', 'value'],
        rows: [
          {
            property: { type: 'iri', value: 'https://schema.org/name' },
            value: { type: 'literal', value: 'a  b' },
          },
        ],
      }}
      onShow={() => {}}
    />
  </SdkLocaleProvider>,
);

// Compile the changed contract from installed declarations, not workspace paths.
function CreationTypes() {
  const definition = fields({ title: text('urn:title', { language: null }) });
  useCreation(definition, { initial: { title: '' }, iri: 'urn:settings' });
  useCreation(definition, { initial: { title: '' }, collection: 'tasks' });
  // @ts-expect-error Exactly one creation address is required.
  useCreation(definition, { initial: { title: '' } });
  // @ts-expect-error A creation cannot choose both address modes.
  useCreation(definition, {
    initial: { title: '' },
    iri: 'urn:settings',
    collection: 'tasks',
  });
  const mutate = useFieldUpdate(definition);
  // @ts-expect-error Creation is no longer a row-hook command.
  void mutate.create;
  // @ts-expect-error Availability belongs to a snapshot's row handle.
  void mutate.canMutate;
  return null;
}
void CreationTypes;

// One guarded switch across Pods (#188).
function PodContextTypes() {
  const lists = usePodContexts({
    podNames: { 'https://pod.example/bob': 'Bob' },
  });
  const first: PodContextChoice | undefined = lists.choices[0];
  const target: ContextTarget | undefined = first;
  const status: string | undefined = lists.pods[0]?.status;
  const select: (t: ContextTarget) => Promise<TargetSelection> =
    useApp().selectTarget;
  void select;
  void lists.select({ connectionId: 'id', contextIri: 'urn:c' }).then((r) => {
    if (r.kind === 'unavailable') {
      const reason:
        'connection' | 'session' | 'catalogue' | 'unlisted' | 'preset' =
        r.reason;
      void reason;
    }
  });
  return [target, status];
}
void PodContextTypes;

// Skipped-entry diagnostics reach both standard list hooks (#187).
function SkippedTypes() {
  const definition = fields(
    { title: text('urn:title', { language: null }) },
    { type: 'urn:Task' },
  );
  const records: readonly SkippedRecord[] =
    useList(definition).data?.skippedRecords ?? [];
  const pod: readonly PodListSkipped[] =
    usePodList(definition).data?.skippedRecords ?? [];
  const reasons: readonly (
    'not-addressable' | 'unreadable' | 'invalid' | 'duplicate'
  )[] = records.map((r) => r.reason);
  const where: readonly string[] = pod.map((r) => r.context);
  const iri: string | null | undefined = records[0]?.iri;
  return [reasons, where, iri];
}
void SkippedTypes;

// The browser's leave prompt is on by default; apps may opt out (#201).
function UnloadPromptTypes(runtime: BrowserRuntime) {
  const app = createAppController(runtime, { unloadPrompt: false });
  const listeners = new Set<() => void>();
  const guard: LeaveGuard = {
    dirty: () => false,
    blocked: () => false,
    discard: () => {},
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  app.register(guard);
  return (
    <SempodsProvider runtime={runtime} unloadPrompt={false}>
      {null}
    </SempodsProvider>
  );
}
void UnloadPromptTypes;

// A read tied to an explicit connection's Pod beside the active one (#236).
function PodLoadTypes(runtime: BrowserRuntime) {
  const select = 'SELECT ?s WHERE { ?s ?p ?o }';
  const active = usePodLoad((pod, signal) =>
    pod.sparql.select(select, { signal }),
  );
  const reader: BoundPod | null = runtime.bindPod('id');
  const explicit = usePodLoad(
    reader,
    (pod, signal) => pod.sparql.select(select, { signal }),
    { key: select, retain: true },
  );
  const none = usePodLoad(null, (pod, signal) =>
    pod.sparql.construct('CONSTRUCT {} WHERE {}', { signal }),
  );
  const state: LoadState<unknown> = explicit.state;
  const rows: number | undefined = explicit.data?.rows.length;
  void explicit.reload().then((s) => s?.kind);
  explicit.cancel();
  return [active.state.kind, state, rows, none.data];
}
void PodLoadTypes;

// A replacement remains an installed public API, also for a standalone gate.
function AccessReplacement({
  surface,
  podAddress,
  podNames,
}: ConnectionsProps) {
  const app = useApp();
  return (
    <button
      data-surface={surface}
      data-address={podAddress}
      onClick={() => void app.connect('https://pod.example/alice')}
    >
      {podNames?.['https://pod.example/alice'] ?? 'Sign in'}
    </button>
  );
}
function CustomAccessTypes() {
  return (
    <AccessGate
      appName="Tasks"
      podAddress="hidden"
      components={{ Connections: AccessReplacement }}
    />
  );
}
void CustomAccessTypes;
