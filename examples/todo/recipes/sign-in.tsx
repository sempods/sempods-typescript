import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { BrowserRuntime, Language } from '@sempods/app-sdk';
import { fields, text } from '@sempods/client-sdk/edit';
import {
  AccessNotice,
  CallbackNotice,
  SempodsProvider,
  TargetScreen,
  UpdateNotice,
  useApp,
  useAppState,
  useCreation,
  useSdkLocale,
  useView,
  useWorkflowAccess,
} from '@sempods/app-sdk/react';

/** App-owned recipe, not a new SDK API or an enforced allowed-Pod policy. */
export function KnownPodControls({ podUrl }: { readonly podUrl: string }) {
  const app = useApp();
  const state = useAppState();
  const { messages: m, error, language } = useSdkLocale();
  // Client discovery accepts only canonical base URLs, without a trailing slash.
  // Keep this configuration stable and reuse the runtime-reported URL verbatim.
  const connection =
    state.connections.find(
      (c) => c.podUrl === podUrl && c.id === state.activeId,
    ) ?? state.connections.find((c) => c.podUrl === podUrl);
  const selected = connection?.id === state.activeId;
  const authenticated =
    connection?.session.kind === 'active' ||
    connection?.session.kind === 'renewing';
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null);
  const unavailable =
    !state.startup ||
    state.startup.storage !== 'durable' ||
    Boolean(state.startupError);
  async function act(action: () => Promise<unknown>) {
    if (
      inFlight.current ||
      unavailable ||
      state.changing ||
      state.confirmingLeave
    )
      return;
    inFlight.current = true;
    setPending(true);
    setFailure(null);
    try {
      await action(); // false means the leave guard declined, not an error.
    } catch (cause) {
      setFailure({ cause });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  const disabled =
    unavailable || pending || connection?.session.kind === 'restoring';
  return (
    <section
      aria-label={m.controls.choosePod}
      style={{ display: 'grid', gap: 8, minWidth: 0 }}
    >
      {!state.startup && !state.startupError && (
        <p role="status">{m.controls.loading}</p>
      )}
      {state.startupError ? (
        <p role="alert">{error(state.startupError)}</p>
      ) : null}
      {state.startup?.storage === 'busy' && (
        <p role="alert">{m.controls.busy}</p>
      )}
      {state.startup?.storage === 'unavailable' && (
        <p role="alert">{m.controls.storage}</p>
      )}
      <CallbackNotice />
      {Boolean(state.startup?.unreadable.length) && (
        <p role="alert">
          {language === 'de'
            ? 'Einige gespeicherte Verbindungen konnten nicht geladen werden.'
            : 'Some saved connections could not be loaded.'}
        </p>
      )}
      <button
        disabled={disabled}
        onClick={() =>
          void act(() =>
            connection ? app.authorize(connection.id) : app.connect(podUrl),
          )
        }
      >
        {authenticated ? m.controls.updateAccess : m.controls.signIn}
      </button>
      {connection?.session.kind === 'restoring' && (
        <p role="status">{m.controls.loading}</p>
      )}
      {connection && !selected && (
        <button
          disabled={disabled}
          onClick={() => void act(() => app.selectConnection(connection.id))}
        >
          {m.controls.choosePod}
        </button>
      )}
      {authenticated && connection && (
        <button
          disabled={disabled}
          onClick={() => void act(() => app.refreshContexts(connection.id))}
        >
          {m.controls.refresh}
        </button>
      )}
      {selected && authenticated && connection?.catalogue.kind === 'ready' && (
        <label style={{ display: 'grid', minWidth: 0 }}>
          {m.dataContext}
          <select
            style={{ width: '100%', minWidth: 0 }}
            value={connection.selectedContext ?? ''}
            disabled={pending}
            onChange={(event) =>
              void act(() => app.selectContext(event.target.value))
            }
          >
            <option value="" disabled>
              {m.chooseContext}
            </option>
            {connection.catalogue.contexts
              .filter((c) => c.readable)
              .map((c) => (
                <option key={c.iri} value={c.iri}>
                  {c.iri}
                </option>
              ))}
          </select>
          {!connection.catalogue.contexts.some((c) => c.readable) && (
            <span>{m.noContexts}</span>
          )}
        </label>
      )}
      {failure && <p role="alert">{error(failure.cause)}</p>}
    </section>
  );
}

/** Keep this region mounted for its target lifetime. Eligibility is a view fact. */
export function AccessPanel({
  podUrl,
  children,
  recovery,
  fallback = 'hidden',
}: {
  readonly podUrl: string;
  readonly children: ReactNode;
  readonly recovery?: ReactNode;
  readonly fallback?: 'hidden' | 'disabled' | { readonly content: ReactNode };
}) {
  const access = useWorkflowAccess();
  const readable =
    access.connection?.podUrl === podUrl && access.current && access.read;
  const notice = useRef<HTMLDivElement>(null);
  const focusInside = useRef(false);
  const { messages } = useSdkLocale();
  useEffect(() => {
    if (!readable && focusInside.current) {
      notice.current?.focus();
      focusInside.current = false;
    }
  }, [readable]);
  return (
    <>
      <div ref={notice} tabIndex={-1} aria-label={messages.reviewAccess}>
        {access.connection?.podUrl === podUrl ? (
          <AccessNotice />
        ) : (
          <p role="status">{messages.controls.noTarget}</p>
        )}
        {recovery}
        {!readable && typeof fallback === 'object' && fallback.content}
      </div>
      <div
        hidden={!readable && fallback !== 'disabled'}
        inert={!readable}
        onFocusCapture={() => {
          focusInside.current = true;
        }}
        onBlurCapture={(event) => {
          if (
            event.relatedTarget &&
            !event.currentTarget.contains(event.relatedTarget)
          )
            focusInside.current = false;
        }}
      >
        {children}
      </div>
    </>
  );
}

const noteFields = fields(
  { title: text('urn:note:title', { language: null }) },
  { type: 'urn:Note' },
);
function Note({
  podUrl,
  fallback,
}: {
  readonly podUrl: string;
  readonly fallback: Parameters<typeof AccessPanel>[0]['fallback'];
}) {
  const creation = useCreation(noteFields, {
    initial: { title: '' },
    collection: 'notes',
  });
  const access = useWorkflowAccess();
  const { language, messages } = useSdkLocale();
  return (
    <AccessPanel
      podUrl={podUrl}
      fallback={fallback ?? 'hidden'}
      recovery={<UpdateNotice {...creation.notice} />}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void creation.create();
        }}
      >
        <label>
          {language === 'de' ? 'Notiz' : 'Note'}
          <input
            value={creation.draft.title}
            disabled={!access.write || !creation.canEdit}
            onChange={(event) => creation.change({ title: event.target.value })}
          />
        </label>
        <button disabled={!access.write || !creation.canCreate}>
          {messages.controls.save}
        </button>
      </form>
    </AccessPanel>
  );
}
function KnownPodContent({
  podUrl,
  fallback,
}: {
  readonly podUrl: string;
  readonly fallback: Parameters<typeof AccessPanel>[0]['fallback'];
}) {
  const view = useView();
  const { language, messages } = useSdkLocale();
  return (
    <>
      <KnownPodControls podUrl={podUrl} />
      {view?.podUrl === podUrl ? (
        <TargetScreen>
          <Note podUrl={podUrl} fallback={fallback} />
        </TargetScreen>
      ) : (
        <AccessPanel podUrl={podUrl} fallback={fallback ?? 'hidden'}>
          <fieldset disabled>
            <label>
              {language === 'de' ? 'Notiz' : 'Note'}
              <input value="" readOnly />
            </label>
            <button disabled>{messages.controls.save}</button>
          </fieldset>
        </AccessPanel>
      )}
    </>
  );
}
/** The host owns and disposes one stable runtime; this component only consumes it. */
export function KnownPodExample({
  runtime,
  podUrl,
  language = 'en',
  fallback = 'hidden',
}: {
  readonly runtime: BrowserRuntime;
  readonly podUrl: string;
  readonly language?: Language;
  readonly fallback?: Parameters<typeof AccessPanel>[0]['fallback'];
}) {
  return (
    <SempodsProvider runtime={runtime} language={language}>
      <KnownPodContent podUrl={podUrl} fallback={fallback} />
    </SempodsProvider>
  );
}
