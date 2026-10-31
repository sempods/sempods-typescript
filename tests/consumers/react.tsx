import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createAppController, createFormatters } from '@sempods/app-sdk';
import { fields, text } from '@sempods/client-sdk/edit';
import {
  SdkLocaleProvider,
  SempodsProvider,
  useSdkLocale,
  useApp,
  useCreation,
  useFieldUpdate,
  useList,
  usePodContexts,
  usePodList,
  type PodContextChoice,
  type PodListSkipped,
} from '@sempods/app-sdk/react';
import type {
  BrowserRuntime,
  ContextTarget,
  LeaveGuard,
  TargetSelection,
} from '@sempods/app-sdk';
import type { SkippedRecord } from '@sempods/client-sdk/edit';

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
