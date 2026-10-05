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
  }
}
const mode = new URL(location.href).searchParams.get('identity') ?? 'dynamic';
const redirectUri = location.origin + '/callback?identity=' + mode;
const runtime = createBrowserRuntime({
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
});
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
