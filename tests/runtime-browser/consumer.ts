import {
  createBrowserRuntime,
  type BrowserRuntime,
  type StartupReport,
} from '@sempods/app-sdk';
import {
  createResourceEditor,
  fields,
  text,
  type SaveOutcome,
} from '@sempods/client-sdk/edit';
declare global {
  interface Window {
    fixture: {
      runtime: BrowserRuntime;
      report?: StartupReport;
      editTask(title: string): Promise<{
        outcome: SaveOutcome;
        review: string | null;
        desiredObserved: boolean | null;
      }>;
    };
    /** The redirect a host-managed sign-in received, and whether it stopped. */
    hostSignIn?: { url: string; aborted: boolean };
  }
}
const mode = new URL(location.href).searchParams.get('identity') ?? 'dynamic';
const redirectUri = location.origin + '/callback?identity=' + mode;
// The harness changes deployment policy across reloads without changing identity.
const policy = sessionStorage.getItem('fixture-policy');
// An app's own navigation to the Pod: through the document's location, which
// ignores the abort signal, or a host-managed sign-in that cancels on it.
const appNavigation = sessionStorage.getItem('fixture-navigate');
const create = () =>
  createBrowserRuntime({
    identity:
      mode === 'did'
        ? {
            kind: 'did-web',
            clientId: 'did:web:127.0.0.1%3A' + location.port,
            redirectUri,
          }
        : { kind: 'dynamic', name: 'Wire fixture', redirectUri },
    scopes: { required: ['tasks'], optional: ['ai'] },
    returnTo: '/app?identity=' + mode,
    development: 'loopback-http',
    ...(appNavigation === 'assign'
      ? { navigate: (url: string) => window.location.assign(url) }
      : appNavigation === 'host'
        ? {
            navigate: (
              url: string,
              { signal }: { readonly signal: AbortSignal },
            ) => {
              const hosted = { url, aborted: false };
              window.hostSignIn = hosted;
              signal.addEventListener('abort', () => {
                hosted.aborted = true;
              });
              return 'signal' as const;
            },
          }
        : appNavigation === 'host-unavailable'
          ? {
              // A host that cannot open its sign-in stays at once, from
              // within its navigation.
              navigate: () => {
                const r = window.fixture.runtime;
                r.cancelAuthorization(r.getSnapshot()[0]!.id);
                return 'signal' as const;
              },
            }
          : {}),
    ...(policy === 'one'
      ? { allowedPods: [location.origin + '/alice'] }
      : policy === 'set'
        ? {
            allowedPods: [location.origin + '/alice', location.origin + '/bob'],
          }
        : {}),
  });
let runtime = create();
window.fixture = {
  runtime,
  async editTask(title) {
    const connection = runtime.getSnapshot()[0]!;
    const editor = createResourceEditor(
      runtime.bind(connection.id),
      'urn:fixture-task',
      fields({
        title: text('https://schema.org/name', { language: 'en' }),
      }),
    );
    try {
      await new Promise<void>((resolve) => {
        const stop = editor.subscribe(() => {
          if (editor.state.phase !== 'loading') {
            stop();
            resolve();
          }
        });
      });
      if (!editor.state.draft)
        throw new Error('Fixture task could not be read');
      editor.change({ ...editor.state.draft, title });
      const outcome = await editor.save();
      return {
        outcome,
        review: editor.state.review?.kind ?? null,
        desiredObserved:
          editor.state.review?.kind === 'unconfirmed'
            ? editor.state.review.desiredObserved
            : null,
      };
    } finally {
      editor.dispose();
    }
  },
};
window.addEventListener('pagehide', () => runtime.dispose());
// As the TODO example: a page restored from the back/forward cache starts a
// runtime again.
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  runtime = create();
  window.fixture.runtime = runtime;
  runtime.subscribe(draw);
  void runtime.initialize().then((report) => {
    window.fixture.report = report;
    draw();
    document.documentElement.dataset.restores = String(
      Number(document.documentElement.dataset.restores ?? 0) + 1,
    );
  });
});
function draw() {
  document.querySelector('pre')!.textContent = JSON.stringify({
    report: window.fixture.report,
    connections: runtime.getSnapshot(),
  });
}
runtime.subscribe(draw);
window.fixture.report = await runtime.initialize();
for (const c of runtime.getSnapshot()) {
  if (c.session.kind !== 'active') continue;
  await runtime.loadContexts(c.id);
  runtime.selectContext(c.id, c.podUrl + '/_system/contexts/work');
}
draw();
for (const name of ['alice', 'bob']) {
  document.querySelector('#' + name)!.addEventListener('click', () => {
    void runtime.connect(location.origin + '/' + name).then(draw);
  });
}
document.querySelector('#login')!.addEventListener('click', () => {
  const connections = runtime.getSnapshot();
  void runtime.beginAuthorization(connections.at(-1)!.id);
});
document.body.dataset.ready = 'true';
