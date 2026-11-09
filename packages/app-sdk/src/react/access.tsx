import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  useApp,
  useAppFacts,
  useAppState,
  useContextDemand,
  useContextDiscovery,
  useDiscoveryDemand,
  useSwitchDemand,
  useWorkflowAccess,
  type AppActions,
} from './app.js';
import type { AppSnapshot } from '../authoring/app.js';
import type { AccessPrompt as AccessPromptFact } from '../authoring/access.js';
import { useSdkLocale } from './locale.js';
import { AccessNotice, CallbackNotice, endedMessage } from './components.js';
import { layered, SdkStyles } from './styles.js';
import { useModalDialog } from './confirm.js';
import { contextName, podName, distinctName } from './names.js';
import type { Connection } from '../runtime/types.js';
import {
  knownContexts,
  presentAccess,
  type ConnectionBody,
} from './access-presentation.js';
import {
  AccessPrompts,
  PromptActions,
  usePromptText,
} from './access-prompts.js';
import { useFirst } from './first.js';

/** What a replacement for the connection view (`components.Connections`) receives. */
export interface ConnectionsProps {
  readonly mode?: 'single' | 'multiple';
  /** Optional app-supplied display names keyed by exact Pod URL. Never identities. */
  readonly podNames?: Readonly<Record<string, string>>;
}
export interface AppAccessProps {
  readonly appName: string;
  /** Heading under a host title; omitted means h1 initially, h2 for management/recovery. */
  readonly headingLevel?: 1 | 2;
  /** Presentation only: single hides adding Pods once connected; allowedPods enforces policy. */
  readonly mode?: 'single' | 'multiple';
  /** App-owned decorative icon, for example <img src="/icon.png" alt="" />. */
  readonly icon?: ReactNode;
  /**
   * A short line about the app under its name on the sign-in screen, for
   * example "Shopping made easy". Display only: it is never sent to the Pod
   * and is not a consent purpose or a scope.
   */
  readonly description?: ReactNode;
  /** Exact Pod URL → friendly name. A name never changes the destination. */
  readonly podNames?: Readonly<Record<string, string>>;
  /**
   * 'hidden' omits the Pod address from sign-in, but only while the runtime
   * permits exactly one Pod; a `podNames` name remains, otherwise saved
   * duplicate connections are numbered. Several or unrestricted
   * Pods, management (`open`) and Full addresses always show the address.
   * A custom `components.Connections` does not receive this option.
   */
  readonly podAddress?: 'visible' | 'hidden';
  /** Host-owned management toggle; demands Context discovery in on-demand mode, never login. */
  readonly open?: boolean;
  /**
   * Shows management (`open`) as a modal dialog with a title and a close
   * button; Escape, the close button and a click beside it call this, which
   * should set `open` to false. Without it, management renders in place.
   */
  readonly onClose?: () => void;
  /**
   * `management`: render only management (while `open`), for an app that
   * composes `AccessGate`, `ContextAccess` and `AccessPrompts` itself. No
   * gate, Context surface or prompts then come from here.
   */
  readonly only?: 'management';
  /**
   * Return focus here once the focused access surface hides and its guarded
   * transition ends. Visible retry or error feedback does not trigger this.
   */
  readonly focusTarget?: RefObject<HTMLElement | null>;
  readonly components?: {
    readonly Connections?: ComponentType<ConnectionsProps>;
  };
  readonly className?: string;
  readonly style?: CSSProperties;
}
/** What `AccessGate` receives: the sign-in screen's own options of `AppAccess`. */
export type AccessGateProps = Pick<
  AppAccessProps,
  | 'appName'
  | 'mode'
  | 'icon'
  | 'description'
  | 'podNames'
  | 'podAddress'
  | 'focusTarget'
  | 'className'
  | 'style'
>;
/** What `ContextAccess` receives: the Context surface's options of `AppAccess`. */
export type ContextAccessProps = Partial<
  Pick<
    AppAccessProps,
    | 'appName'
    | 'headingLevel'
    | 'mode'
    | 'icon'
    | 'description'
    | 'podNames'
    | 'podAddress'
    | 'focusTarget'
    | 'components'
    | 'className'
    | 'style'
  >
>;
const unavailablePod = Object.freeze({
  current: false,
  read: false,
  revision: 0,
});
const noSubscription = () => () => {};

/**
 * The default access UI: `AccessGate` (the sign-in screen while the app
 * cannot work), `ContextAccess` (Context selection and catalogue recovery),
 * `AccessPrompts` (dialogs and toasts at the bottom of the viewport) and,
 * while `open`, management of Pods and sharing. With `only="management"` it
 * renders management alone, for an app that places the other parts itself.
 * Keep it outside hidden/inert widget regions and keep TargetScreen/editor
 * children mounted during same-target access loss: the gate covers them as a
 * modal layer, they stay mounted. Inline, scoped defaults use shared
 * --sempods-* CSS variables; no stylesheet import or UI framework is
 * required. A CSP must permit this component's styles.
 */
export function AppAccess({
  only,
  open = false,
  onClose,
  ...props
}: AppAccessProps) {
  const asDialog = open && Boolean(onClose);
  // Management in place would sit behind the gate; the dialog opens above it.
  const blocked = useAppFacts(selectBlocking) !== null;
  const management = !open ? null : asDialog ? (
    <Management {...props} onClose={onClose!} />
  ) : blocked ? null : (
    <AccessSection {...props} manage />
  );
  if (only === 'management') return management;
  return (
    <>
      <Gate {...props} />
      {/* Management in place already shows the connection view. */}
      {!(open && !asDialog) && <AccessSection {...props} manage={false} />}
      <AccessPrompts
        {...(props.focusTarget ? { focusTarget: props.focusTarget } : {})}
      />
      {management}
    </>
  );
}

/**
 * Context selection and catalogue recovery, outside access prompts. It shows
 * while the active connection is usable and a flow demands a Context: a
 * selection (`TargetScreen`, the `required` mode) with the chooser, the first
 * load, an empty or unreadable catalogue, a failed one with retry and an
 * unavailable preset Context; or only discovery (an explicit target such as
 * `useContextEditor`) with the catalogue status and retry, without a chooser.
 * It renders nothing otherwise. Part of `AppAccess`.
 */
export function ContextAccess(props: ContextAccessProps) {
  return <AccessSection {...props} manage={false} />;
}

function Management({
  onClose,
  focusTarget,
  ...props
}: Omit<AppAccessProps, 'open' | 'only' | 'onClose'> & {
  readonly onClose: () => void;
}) {
  const { messages: m } = useSdkLocale();
  const app = useApp();
  const activeId = useAppFacts((s) => {
    const c = s.connections.find((entry) => entry.id === s.activeId);
    return c?.session.kind === 'active' || c?.session.kind === 'renewing'
      ? c.id
      : null;
  });
  // Opening the management dialog checks the access again, so it needs no
  // separate button.
  const refreshContexts = app.refreshContexts;
  useLayoutEffect(() => {
    if (activeId) void refreshContexts(activeId).catch(() => {});
  }, [activeId, refreshContexts]);
  return (
    <ManagementDialog
      title={m.controls.dataAccess}
      onClose={onClose}
      {...(focusTarget ? { returnFocus: focusTarget } : {})}
    >
      <AccessSection {...props} manage asDialog />
    </ManagementDialog>
  );
}

/**
 * The connection view: Context flows inline (`manage` false) or management.
 * Session problems belong to the gate and the prompts.
 */
function AccessSection({
  appName,
  headingLevel,
  mode = 'multiple',
  icon,
  description,
  podNames,
  podAddress = 'visible',
  manage,
  asDialog = false,
  focusTarget,
  components,
  className,
  style,
}: ContextAccessProps & {
  readonly manage: boolean;
  readonly asDialog?: boolean;
}) {
  const state = useAppState();
  const access = useWorkflowAccess();
  // Management lists the Contexts (discovery); only a Context flow, or the
  // required mode, asks for a selected one.
  const contextRequired = useContextDemand(false);
  useContextDiscovery(manage);
  // An explicit target (useContextEditor) needs the catalogue, not a selection.
  const discoveryDemand = useDiscoveryDemand();
  const switching = useSwitchDemand();
  const discovery = contextRequired || discoveryDemand;
  const podAccess = useSyncExternalStore(
    state.pod?.subscribe ?? noSubscription,
    state.pod?.getSnapshot ?? (() => unavailablePod),
    state.pod?.getSnapshot ?? (() => unavailablePod),
  );
  const { messages: m, direction } = useSdkLocale();
  const heldFocus = useRef(false);
  const c = access.connection;
  // Scoped to this provider's controller: a replacement runtime restoring the
  // same connection ID loads its first catalogue again.
  const app = useApp();
  const [settledCatalogue, setSettledCatalogue] = useState<{
    readonly app: AppActions;
    readonly id: string;
  } | null>(null);
  const settledHere = settledCatalogue?.app === app && settledCatalogue.id;
  if (
    c &&
    (c.catalogue.kind === 'ready' || c.catalogue.kind === 'failed') &&
    settledHere !== c.id
  )
    setSettledCatalogue({ app, id: c.id });
  // A reload after `ready` keeps the earlier contexts, also for an instance
  // mounted during that reload.
  const catalogueSettled =
    settledHere === c?.id ||
    (c?.catalogue.kind === 'loading' && Boolean(knownContexts(c.catalogue)));
  const presentation = presentAccess({
    state,
    connection: c,
    podReadable: podAccess.read,
    viewReadable: access.read,
    hasView: Boolean(state.view),
    demand: contextRequired
      ? 'selection'
      : discoveryDemand
        ? 'discovery'
        : 'none',
    manage,
    catalogueSettled,
    ...(headingLevel === undefined ? {} : { headingLevel }),
  });
  const { body, notice, heading: Heading, namesApp } = presentation;
  const hidden = !presentation.visible;
  useLayoutEffect(() => {
    // Guarded target changes temporarily make the whole provider inert. Restore
    // focus only after that transition and once access feedback has hidden.
    if (
      hidden &&
      !state.changing &&
      !state.confirmingLeave &&
      heldFocus.current
    ) {
      heldFocus.current = false;
      focusTarget?.current?.focus();
    }
  }, [hidden, focusTarget, state.changing, state.confirmingLeave]);
  const Connections = components?.Connections;
  return (
    <section
      onFocusCapture={() => {
        heldFocus.current = true;
      }}
      onBlurCapture={(event) => {
        if (
          event.relatedTarget &&
          event.relatedTarget !== event.currentTarget.ownerDocument.body &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          heldFocus.current = false;
      }}
      hidden={hidden}
      data-sempods-access=""
      data-sempods-ui="access"
      aria-label={m.controls.dataAccess}
      dir={direction}
      className={className}
      style={hidden ? { ...style, display: 'none' } : style}
    >
      <SdkStyles />
      <style href="sempods-access" precedence="sempods">
        {layered(styles)}
      </style>
      {!hidden && (
        <div className="sp-access-content">
          {!asDialog && (
            <header>
              {icon && namesApp && appName && (
                <div className="sp-access-icon" aria-hidden="true">
                  {icon}
                </div>
              )}
              <Heading>
                {namesApp && appName ? appName : m.controls.dataAccess}
              </Heading>
              {namesApp && appName && description && (
                <p className="sp-access-description">{description}</p>
              )}
            </header>
          )}
          {Connections ? (
            body === 'leaving' ? (
              <p role="status">{m.controls.leaving ?? m.controls.loading}</p>
            ) : body === 'loading' ? (
              <p role="status">{m.controls.loading}</p>
            ) : (
              <Connections mode={mode} {...(podNames ? { podNames } : {})} />
            )
          ) : (
            <AccessConnections
              contextRequired={contextRequired}
              switching={switching}
              // The dialog checks the access again on opening instead.
              discovery={discovery && !asDialog}
              manage={manage}
              mode={mode}
              body={body}
              podAddress={podAddress}
              {...(podNames ? { podNames } : {})}
            />
          )}
          {notice && <AccessNotice />}
        </div>
      )}
    </section>
  );
}

const selectBlocking = (s: AppSnapshot) => s.access.blocking;
/** The custom properties of a style, such as `--sempods-*` tokens. */
function tokensOf(style: CSSProperties | undefined) {
  if (!style) return undefined;
  const tokens = Object.fromEntries(
    Object.entries(style).filter(([name]) => name.startsWith('--')),
  );
  return Object.keys(tokens).length ? (tokens as CSSProperties) : undefined;
}
/** The gate's reasons that sign in: they show the connection view. */
const signInReasons = new Set<AccessPromptFact['reason']>([
  'no-connection',
  'signed-out',
  'missing-scopes',
]);

/**
 * The sign-in screen while the app cannot work (`access.blocking`): a
 * full-viewport modal layer above the app, whose content stays mounted and
 * inert, so drafts stay in memory. It does not close on Escape and offers no
 * way back to the content until the cause ends. For `no-connection`,
 * `signed-out` and `missing-scopes` it shows the sign-in view: remembered
 * Pods, the other connections and, without a connection, the address input
 * (keeping `allowedPods`). Every other reason shows its own actions only.
 * `className` and `style` apply to its access surface as in `AppAccess`;
 * custom properties such as `--sempods-*` tokens also cover the whole layer.
 */
export function AccessGate(props: AccessGateProps) {
  return <Gate {...props} />;
}

function Gate(
  props: Omit<AppAccessProps, 'open' | 'onClose' | 'only'> &
    Partial<Pick<AppAccessProps, 'appName'>>,
) {
  const blocking = useAppFacts(selectBlocking);
  // One gate per provider, also with several AppAccess instances.
  const first = useFirst('gate');
  return blocking && first ? (
    <GateDialog {...props} blocking={blocking} />
  ) : null;
}

function GateDialog({
  appName,
  mode = 'multiple',
  icon,
  description,
  podNames,
  podAddress = 'visible',
  focusTarget,
  components,
  className,
  style,
  blocking,
}: Omit<AppAccessProps, 'open' | 'onClose' | 'only' | 'appName'> & {
  readonly appName?: string;
  readonly blocking: AccessPromptFact;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const label = useId();
  const { messages: m, direction } = useSdkLocale();
  useModalDialog(dialog, true, focusTarget);
  useLayoutEffect(() => {
    // A gate that opens after management or a leave confirmation must not
    // cover them: the top layer stacks by opening order, so raise them again.
    const above =
      dialog.current?.ownerDocument.querySelectorAll<HTMLDialogElement>(
        'dialog[data-sempods-ui="management"][open], dialog[data-sempods-ui="leave"][open]',
      );
    for (const element of above ?? []) {
      if (typeof element.showModal !== 'function') continue;
      const focused = element.contains(element.ownerDocument.activeElement)
        ? (element.ownerDocument.activeElement as HTMLElement)
        : null;
      element.close();
      element.showModal();
      focused?.focus();
    }
  }, []);
  const text = usePromptText(blocking);
  const signIn = signInReasons.has(blocking.reason);
  const startup =
    blocking.reason === 'startup-failed' ||
    blocking.reason === 'other-tab' ||
    blocking.reason === 'storage';
  const Connections = components?.Connections;
  return (
    <dialog
      ref={dialog}
      aria-labelledby={label}
      data-sempods-ui="gate"
      data-reason={blocking.reason}
      className="sp-access-gate"
      dir={direction}
      // Custom properties (--sempods-* tokens) also cover the whole layer.
      style={tokensOf(style)}
      // The gate ends only with its cause.
      onCancel={(event) => event.preventDefault()}
    >
      <SdkStyles />
      <style href="sempods-access" precedence="sempods">
        {layered(styles)}
      </style>
      <section
        data-sempods-access=""
        data-sempods-ui="access"
        aria-label={m.controls.dataAccess}
        className={className}
        style={style}
      >
        <div className="sp-access-content">
          <header>
            {icon && (
              <div className="sp-access-icon" aria-hidden="true">
                {icon}
              </div>
            )}
            <h1 id={label}>{appName ?? m.controls.dataAccess}</h1>
            {description && (
              <p className="sp-access-description">{description}</p>
            )}
          </header>
          {!startup && <CallbackNotice />}
          {signIn ? (
            <>
              {blocking.reason === 'missing-scopes' && text && (
                <p role="status">{text}</p>
              )}
              {Connections ? (
                <Connections mode={mode} {...(podNames ? { podNames } : {})} />
              ) : (
                <AccessConnections
                  contextRequired={false}
                  switching={false}
                  discovery={false}
                  manage={false}
                  mode={mode}
                  body="connections"
                  podAddress={podAddress}
                  {...(podNames ? { podNames } : {})}
                />
              )}
            </>
          ) : (
            <>
              {text && <p role="alert">{text}</p>}
              <PromptActions prompt={blocking} />
            </>
          )}
        </div>
      </section>
    </dialog>
  );
}

/**
 * Management as a native modal dialog in the top layer: the app behind it is
 * inert, and a leave confirmation still opens above it.
 */
function ManagementDialog({
  title,
  onClose,
  returnFocus,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  /** Focus after closing (`focusTarget`); otherwise the element focused before. */
  readonly returnFocus?: RefObject<HTMLElement | null>;
  readonly children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const label = useId();
  const { messages: m, direction } = useSdkLocale();
  useModalDialog(dialog, true, returnFocus);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={label}
      data-sempods-ui="management"
      className="sp-sdk-dialog sp-access-dialog"
      dir={direction}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop reaches the dialog element itself.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <SdkStyles />
      <header className="sp-access-dialog-header">
        <h2 id={label}>{title}</h2>
        <button
          className="sp-access-close"
          aria-label={m.controls.close}
          title={m.controls.close}
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </header>
      {children}
    </dialog>
  );
}

/** Presentation-only convenience. Canonical URL/security validation stays in the runtime. */
function enteredPod(value: string) {
  // Only clean up the common pasted-address form. Do not parse/re-serialize the
  // URL: that could silently normalize ambiguous paths, credentials or escapes.
  const text = value.trim().replace(/\/$/, '');
  return /^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`;
}

function AccessConnections({
  manage,
  mode,
  podNames,
  contextRequired,
  switching,
  discovery,
  body,
  podAddress,
}: {
  readonly manage: boolean;
  readonly mode: 'single' | 'multiple';
  readonly podNames?: Readonly<Record<string, string>>;
  readonly podAddress: 'visible' | 'hidden';
  readonly contextRequired: boolean;
  /** The app selects through its own switch (`useContexts`): no chooser here. */
  readonly switching: boolean;
  /** Catalogue discovery is demanded and checked by hand (**Check access**). */
  readonly discovery: boolean;
  readonly body: ConnectionBody;
}) {
  const app = useApp();
  const state = useAppState();
  const { messages: m, error } = useSdkLocale();
  const id = useId();
  const disconnectId = useId();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null);
  // Remembered Pods: signed out at a known address (see `rememberPods`). The
  // sign-in view lists them above the address field, each with its own
  // sign-in and a way to forget it on this device. A Pod being forgotten
  // stays in that list; if forgetting could not be saved, with the failure
  // and Forget again, so its address is not kept against the choice.
  const forgetting = (entry: Connection) =>
    entry.session.kind === 'ended' && entry.session.forget === true;
  const remembered = state.connections.filter(
    (entry) => entry.session.kind === 'signed-out' || forgetting(entry),
  );
  const found = state.connections.find((entry) => entry.id === state.activeId);
  // The connection shown as connected; a remembered active one is signed in
  // to from its list, so the rest of this view treats it as none.
  const c = found && !remembered.includes(found) ? found : undefined;
  const disconnectFailed =
    c?.session.kind === 'ended' && c.session.saved === false;
  const disconnectHint = disconnectFailed
    ? m.controls.disconnectFailed
    : m.controls.disconnectHint;
  const active = c?.session.kind === 'active' || c?.session.kind === 'renewing';
  const defaultUrl =
    state.preset?.podUrl ??
    (state.allowedPods?.length === 1 ? state.allowedPods[0] : undefined);
  // With exactly one permitted Pod the configuration fixes the destination, so
  // sign-in may omit its address; management keeps it inspectable.
  const addressHidden =
    podAddress === 'hidden' &&
    !manage &&
    state.allowedPods?.length === 1 &&
    defaultUrl === state.allowedPods[0];
  const fixedContext =
    state.preset?.podUrl === c?.podUrl ? state.preset?.contextIri : undefined;
  // A reload (for example on opening the dialog) keeps the earlier Contexts
  // on screen until it settles, so the view does not change size meanwhile.
  const readable = (knownContexts(c?.catalogue) ?? []).filter(
    (entry) => entry.readable,
  );
  const unavailable =
    busy ||
    state.changing ||
    state.confirmingLeave ||
    !state.startup ||
    state.startup.storage !== 'durable' ||
    Boolean(state.startupError);
  async function act(task: () => Promise<unknown>) {
    if (inFlight.current || unavailable) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await task();
    } catch (cause) {
      setFailure({ cause });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function connect(target: string) {
    // Reuse a permitted stored or prepared connection, including after a failed
    // authorization preparation. The controller still guards selection/login.
    const existing =
      state.connections.find(
        (entry) => entry.id === state.activeId && entry.podUrl === target,
      ) ?? state.connections.find((entry) => entry.podUrl === target);
    if (existing) {
      if (existing.session.kind === 'restoring') return;
      // Keep the current target/drafts until preparation succeeds. The completed
      // callback activates this connection; selecting first would discard drafts
      // even if discovery or durable authorization preparation subsequently fails.
      await app.authorize(existing.id);
    } else await app.connect(target);
  }
  const showNew = (manage && mode === 'multiple') || !c;
  const showDefault =
    (mode === 'multiple' || !c) &&
    defaultUrl &&
    c?.podUrl !== defaultUrl &&
    !remembered.some((entry) => entry.podUrl === defaultUrl) &&
    !(manage && !state.allowedPods);
  const choice = url || defaultUrl || '';
  // The callback notice already names why this connection's sign-in ended.
  const shownByNotice =
    state.callbackNotice &&
    state.startup?.attemptConnectionId === c?.id &&
    c?.session.kind === 'ended' &&
    c.session.problem === state.startup?.problem;
  const name = (target: string) =>
    distinctName(
      target,
      state.allowedPods ?? state.connections.map((entry) => entry.podUrl),
      (value) => podName(value, podNames),
    );
  // Without a podNames entry the derived name is the address itself.
  const podLine = (target: string, lineId?: string) =>
    (!addressHidden || podNames?.[target]?.trim()) && (
      <p id={lineId}>{name(target)}</p>
    );
  // Management names the Pod its actions target; a display name never
  // replaces that Pod's address, also beside several saved connections.
  const namedAddress = (target: string) =>
    podNames?.[target]?.trim() && <p className="sp-access-address">{target}</p>;
  const labels =
    c?.catalogue.kind !== 'unknown' ? c?.catalogue.labels : undefined;
  const selectedEntry = readable.find(
    (entry) => entry.iri === c?.selectedContext,
  );
  // What the catalogue says this app may do in a Context.
  const accessFact = (entry: { readonly writable: boolean }) => (
    <span className="sp-access-fact">
      {entry.writable ? m.controls.canChange : m.controls.canRead}
    </span>
  );
  // One readable Context, already selected: a choice adds nothing. With an
  // app-owned switch, the selected Context is only named here.
  const onlyContext =
    readable.length === 1 && selectedEntry ? selectedEntry : undefined;
  const named = onlyContext ?? (switching ? selectedEntry : undefined);
  const contextLabel = (iri: string) =>
    distinctName(
      iri,
      readable.map((entry) => entry.iri),
      (value) => contextName(value, labels),
    );
  // Keyed so that switching between the validating and connection views keeps
  // these controls (and keyboard focus) mounted.
  const defaultSignIn = showDefault && defaultUrl && (
    <div key="default-sign-in">
      {podLine(defaultUrl)}
      {!addressHidden && podNames?.[defaultUrl] && (
        <p className="sp-access-address">{defaultUrl}</p>
      )}
      <button
        className={found ? undefined : 'sp-access-primary'}
        disabled={
          unavailable ||
          state.connections.some(
            (entry) =>
              entry.podUrl === defaultUrl && entry.session.kind === 'restoring',
          )
        }
        onClick={() => void act(() => connect(defaultUrl))}
      >
        {m.controls.signIn}
      </button>
    </div>
  );
  // A remembered Pod is chosen from its own list, unless it is the active one.
  const selectable = state.connections.filter(
    (entry) => !remembered.includes(entry) || entry.id === state.activeId,
  );
  const activePod = selectable.length > 1 && (
    <label key="active-pod">
      {m.activePod}
      <select
        aria-label={m.activePod}
        value={state.activeId ?? ''}
        disabled={unavailable}
        onChange={(event) =>
          void act(() => app.selectConnection(event.target.value))
        }
      >
        <option value="" disabled>
          {m.controls.choosePod}
        </option>
        {selectable.map((entry) => {
          const index = state.connections.indexOf(entry) + 1;
          // Saved duplicates of the one permitted Pod: number them rather
          // than fall back to the hidden address.
          if (addressHidden && !podNames?.[entry.podUrl]?.trim())
            return (
              <option key={entry.id} value={entry.id}>
                {index}
              </option>
            );
          return (
            <option key={entry.id} value={entry.id}>
              {name(entry.podUrl)}
              {state.connections.filter(
                (other) => other.podUrl === entry.podUrl,
              ).length > 1
                ? ` · ${index}`
                : ''}
            </option>
          );
        })}
      </select>
    </label>
  );
  // Signing in to a new Pod. In management of a connection it is a secondary,
  // collapsed action after the connected Pod.
  const another = manage && Boolean(c);
  const rememberedList = remembered.length > 0 && (
    <ul
      key="remembered"
      className="sp-access-remembered"
      aria-label={m.controls.rememberedPods}
    >
      {remembered.map((entry) => {
        const ended =
          entry.session.kind === 'signed-out' &&
          entry.session.problem !== undefined &&
          entry.session.problem !== 'disconnected';
        const line = podLine(entry.podUrl, `${id}-${entry.id}`);
        const failed =
          entry.session.kind === 'ended' && entry.session.saved === false;
        const describedBy =
          [line && `${id}-${entry.id}`, failed && `${id}-${entry.id}-failed`]
            .filter(Boolean)
            .join(' ') || undefined;
        return (
          <li key={entry.id}>
            {line}
            {!addressHidden && namedAddress(entry.podUrl)}
            {ended && (
              <p className="sp-access-hint">{m.controls.sessionEnded}</p>
            )}
            {failed && (
              <p id={`${id}-${entry.id}-failed`} role="alert">
                {m.controls.forgetFailed}
              </p>
            )}
            <div className="sp-access-actions">
              {!forgetting(entry) && (
                <button
                  className={
                    entry.id === state.activeId
                      ? 'sp-access-primary'
                      : undefined
                  }
                  aria-describedby={line ? `${id}-${entry.id}` : undefined}
                  disabled={unavailable}
                  onClick={() => void act(() => app.authorize(entry.id))}
                >
                  {m.controls.signIn}
                </button>
              )}
              <button
                aria-describedby={describedBy}
                disabled={unavailable}
                onClick={() => void act(() => app.forget(entry.id))}
              >
                {m.controls.forget}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
  const actions = (
    <>
      {c && (
        <div className="sp-access-actions">
          {active && (
            <>
              <button
                disabled={unavailable}
                onClick={() => void act(() => app.authorize(c.id))}
              >
                {m.controls.updateAccess}
              </button>
              {discovery && (
                <button
                  disabled={unavailable}
                  onClick={() => void act(() => app.refreshContexts(c.id))}
                >
                  {m.controls.checkAccess}
                </button>
              )}
            </>
          )}
          {(manage || c.session.kind === 'ended') && (
            // After a failed sign-out it is the main action: repeat it.
            <button
              className={disconnectFailed ? 'sp-access-primary' : undefined}
              disabled={unavailable}
              aria-describedby={disconnectHint ? disconnectId : undefined}
              onClick={() => void act(() => app.disconnect(c.id))}
            >
              {disconnectFailed ? m.controls.retry : m.controls.disconnect}
            </button>
          )}
        </div>
      )}
      {c && (manage || c.session.kind === 'ended') && disconnectHint && (
        <p
          id={disconnectId}
          role={disconnectFailed ? 'alert' : undefined}
          className="sp-access-hint"
        >
          {disconnectHint}
        </p>
      )}
    </>
  );
  const addPod =
    showNew && state.allowedPods && state.allowedPods.length > 1 ? (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (choice) void act(() => connect(choice));
        }}
      >
        <label>
          {m.controls.yourPod}
          <select
            aria-label={m.controls.yourPod}
            required
            value={choice}
            disabled={unavailable}
            onChange={(event) => setUrl(event.target.value)}
          >
            <option value="" disabled>
              {m.controls.choosePod}
            </option>
            {state.allowedPods.map((target) => (
              <option key={target} value={target}>
                {name(target)}
              </option>
            ))}
          </select>
        </label>
        {choice && <p className="sp-access-address">{choice}</p>}
        <button
          className={found ? undefined : 'sp-access-primary'}
          disabled={
            unavailable ||
            !choice ||
            state.connections.some(
              (entry) =>
                entry.podUrl === choice && entry.session.kind === 'restoring',
            )
          }
        >
          {m.controls.signIn}
        </button>
      </form>
    ) : defaultSignIn ? (
      defaultSignIn
    ) : showNew && !state.allowedPods && (!state.preset || manage) ? (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void act(() => connect(enteredPod(url)));
        }}
      >
        <label>
          {m.controls.yourPod}
          <input
            type="text"
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={url}
            aria-describedby={m.controls.podHint ? id : undefined}
            placeholder="sempods.org/alice"
            disabled={unavailable}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        {m.controls.podHint && (
          <p id={id} className="sp-access-hint">
            {m.controls.podHint}
          </p>
        )}
        <button
          className={found ? undefined : 'sp-access-primary'}
          disabled={unavailable}
        >
          {m.controls.signIn}
        </button>
      </form>
    ) : null;

  // The page is navigating to the Pod's sign-in: no action applies any more.
  if (body === 'leaving')
    return <p role="status">{m.controls.leaving ?? m.controls.loading}</p>;
  // A restore that never settles must not hide signing in to the configured
  // Pod, to a remembered one, or switching to another saved one.
  if (body === 'loading')
    return (
      <>
        {defaultSignIn}
        {rememberedList}
        {activePod}
        <p role="status">{m.controls.loading}</p>
        {failure && <p role="alert">{error(failure.cause)}</p>}
      </>
    );
  return (
    <>
      {!another && rememberedList}
      {!another && addPod}
      {!found && m.controls.loginHint && (
        <p className="sp-access-hint">{m.controls.loginHint}</p>
      )}
      {activePod}
      {/* Without the Pod selector, the active Pod is named here. */}
      {manage && active && selectable.length < 2 && podLine(c!.podUrl)}
      {manage && active && namedAddress(c!.podUrl)}
      {c?.session.kind === 'restoring' && (
        <p role="status">{m.controls.loading}</p>
      )}
      {c && !active && c.session.kind !== 'restoring' && (
        <>
          {podLine(c.podUrl)}
          {manage && namedAddress(c.podUrl)}
          {c.session.kind === 'ended' &&
            !disconnectFailed &&
            !shownByNotice && (
              <p role="status">{endedMessage(c.session, m, true)}</p>
            )}
          {/* After a failed sign-out, the sign-out button repeats it. */}
          {disconnectFailed ? null : c.session.kind === 'ended' &&
            c.session.restorable ? (
            // The Pod was unreachable, not the session lost: no new sign-in.
            <button
              className="sp-access-primary"
              disabled={unavailable}
              onClick={() => void act(() => app.retryRestore(c.id))}
            >
              {m.controls.retry}
            </button>
          ) : (
            <button
              className="sp-access-primary"
              disabled={unavailable}
              onClick={() => void act(() => app.authorize(c.id))}
            >
              {m.controls.signIn}
            </button>
          )}
        </>
      )}
      {active && contextRequired && !fixedContext && named ? (
        // Set off below the Pod: the Context this app works in.
        <p className="sp-access-context">
          {contextLabel(named.iri)}
          {' · '}
          {accessFact(named)}
        </p>
      ) : active &&
        contextRequired &&
        !fixedContext &&
        switching &&
        !c?.selectedContext ? (
        // The app's own switch selects a first Context; this only waits. A
        // kept selection that lost access needs the chooser below instead.
        readable.length > 0 && <p role="status">{m.controls.loading}</p>
      ) : active && contextRequired && !fixedContext ? (
        <label>
          {m.dataContext}
          <select
            aria-label={m.dataContext}
            value={c?.selectedContext ?? ''}
            disabled={
              unavailable ||
              c?.catalogue.kind !== 'ready' ||
              readable.length === 0
            }
            onChange={(event) =>
              void act(() => app.selectContext(event.target.value))
            }
          >
            <option value="" disabled>
              {m.chooseContext}
            </option>
            {readable.map((entry) => (
              <option key={entry.iri} value={entry.iri}>
                {contextLabel(entry.iri)}
              </option>
            ))}
          </select>
          {selectedEntry && accessFact(selectedEntry)}
        </label>
      ) : null}
      {active && contextRequired && fixedContext && (
        <p>
          {m.dataContext}: {contextLabel(fixedContext)}
        </p>
      )}
      {active &&
        (contextRequired || manage) &&
        !fixedContext &&
        c?.catalogue.kind === 'ready' &&
        readable.length === 0 && <p role="status">{m.noContexts}</p>}
      {manage &&
        active &&
        c?.catalogue.kind === 'loading' &&
        !c.catalogue.contexts && <p role="status">{m.cataloguePending}</p>}
      {manage && active && !contextRequired && readable.length > 0 && (
        // What the catalogue says this app may do in each readable Context:
        // caller-relative rights, not which grant or public access gave them.
        <section aria-label={m.controls.contextAccess}>
          <p className="sp-access-label">{m.controls.contextAccess}</p>
          <ul className="sp-access-contexts">
            {readable.map((entry) => (
              <li key={entry.iri}>
                <span>{contextLabel(entry.iri)}</span>
                {accessFact(entry)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {manage && actions}
      {/* Management and the remembered list already show the Pod address. */}
      {c && !manage && (
        <details>
          <summary>{m.controls.addresses}</summary>
          <p>{c.podUrl}</p>
          {c.selectedContext &&
            !readable.some((entry) => entry.iri === c.selectedContext) && (
              <p>{c.selectedContext}</p>
            )}
          <dl>
            {readable.map((entry) => (
              <div key={entry.iri}>
                <dt>{contextLabel(entry.iri)}</dt>
                <dd>{entry.iri}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {!manage && actions}
      {another && (addPod || rememberedList) && (
        <details className="sp-access-another">
          <summary>{m.controls.connectAnother}</summary>
          {rememberedList}
          {addPod}
        </details>
      )}
      {failure && <p role="alert">{error(failure.cause)}</p>}
    </>
  );
}

const styles = `
[data-sempods-access] { padding:clamp(16px,4vw,32px); text-align:center; }
[data-sempods-access][hidden] { display:none; }
[data-sempods-access] * { box-sizing:border-box; }
[data-sempods-access] .sp-access-content { width:100%; max-width:22rem; margin-inline:auto; }
[data-sempods-access] header { margin:0 0 28px; }
[data-sempods-access] h1, [data-sempods-access] h2 { font-size:1.75rem; font-weight:500; line-height:1.25; margin:0; }
[data-sempods-access] .sp-access-icon { margin:0 auto 20px; width:56px; height:56px; }
[data-sempods-access] .sp-access-icon > * { width:100%; height:100%; object-fit:contain; }
[data-sempods-access] p { overflow-wrap:anywhere; margin:12px 0; }
[data-sempods-access] label { display:block; text-align:start; margin:18px 0; }
[data-sempods-access] input, [data-sempods-access] select { display:block; width:100%; min-width:0; margin:8px 0; font:inherit; color:inherit; background:var(--sp-bg); border:1px solid var(--sp-field-line); border-radius:4px; padding:12px; min-height:46px; }
[data-sempods-access] input { border-width:0 0 1px; border-radius:0; padding-inline:0; }
[data-sempods-access] select { appearance:none; border-width:0 0 1px; border-radius:0; padding:12px 24px 12px 0; cursor:pointer; background-image:linear-gradient(45deg,transparent 50%,var(--sp-muted) 50%),linear-gradient(135deg,var(--sp-muted) 50%,transparent 50%); background-position:calc(100% - 10px) 50%,calc(100% - 5px) 50%; background-size:5px 5px; background-repeat:no-repeat; }
[data-sempods-access] input::placeholder { color:var(--sp-muted); opacity:1; }
[data-sempods-access] button { min-height:44px; font:inherit; font-weight:500; border:1px solid var(--sp-secondary-border); border-radius:calc(var(--sp-radius) * .625); color:var(--sp-secondary-text); background:var(--sp-secondary-bg); padding:9px 13px; cursor:pointer; }
[data-sempods-access] button:hover:not(:disabled) { background:color-mix(in oklch,var(--sp-secondary-bg),var(--sp-secondary-text) 8%); }
[data-sempods-access] .sp-access-primary { width:100%; margin-top:12px; color:var(--sp-primary-text); background:var(--sp-primary-bg); border:2px solid var(--sp-primary-border); padding:8px 12px; }
[data-sempods-access] .sp-access-primary:hover:not(:disabled) { background:color-mix(in oklch,var(--sp-primary-bg),var(--sp-primary-text) 12%); }
[data-sempods-access] :disabled { opacity:.55; cursor:default; }
[data-sempods-access] :focus-visible { outline:2px solid var(--sp-focus); outline-offset:3px; }
[data-sempods-access] .sp-access-hint, [data-sempods-access] .sp-access-address, [data-sempods-access] details { font-size:.875rem; color:var(--sp-muted); }
[data-sempods-access] .sp-access-contexts { list-style:none; margin:8px 0 16px; padding:0; text-align:start; }
[data-sempods-access] .sp-access-contexts li { display:flex; flex-wrap:wrap; justify-content:space-between; gap:4px 12px; padding:8px 0; border-block-end:1px solid var(--sp-line); }
[data-sempods-access] .sp-access-label, [data-sempods-access] .sp-access-fact { font-size:.875rem; color:var(--sp-muted); }
[data-sempods-access] .sp-access-context { margin:4px 0 16px; padding-inline-start:12px; border-inline-start:2px solid var(--sp-line); text-align:start; }
[data-sempods-access] .sp-access-label { text-align:start; margin:16px 0 0; }
[data-sempods-access] .sp-access-another { margin-top:16px; }
[data-sempods-access] .sp-access-remembered { list-style:none; margin:0 0 16px; padding:0; }
[data-sempods-access] .sp-access-remembered li { padding:8px 0; border-block-end:1px solid var(--sp-line); }
[data-sempods-access] .sp-access-remembered p { margin:4px 0; }
[data-sempods-access] .sp-access-remembered .sp-access-actions { margin-top:8px; }

[data-sempods-access] .sp-access-description { margin:8px 0 0; color:var(--sp-muted); }
[data-sempods-access] .sp-access-actions { display:flex; flex-wrap:wrap; gap:4px; justify-content:center; margin-top:16px; }
[data-sempods-access] details { margin-top:16px; overflow-wrap:anywhere; }
[data-sempods-access] [data-sempods-ui="notice"][role=alert] { border-width:1px; border-style:solid; border-color:var(--sp-line); border-radius:calc(var(--sp-radius) * .625); padding:10px 12px; }
[data-sempods-access] summary { min-height:44px; padding:10px; cursor:pointer; }
/* The gate covers the viewport above the app, which stays mounted behind it. */
.sp-access-gate { position:fixed; inset:0; width:100%; height:100%; max-width:none; max-height:none; margin:0; padding:0; border:0; background:var(--sp-bg); color:var(--sp-text); overflow:auto; }
.sp-access-gate[open] { display:grid; align-items:center; }
.sp-access-gate::backdrop { background:var(--sp-bg); }
.sp-access-dialog { width:min(28rem,calc(100vw - 32px)); max-width:none; max-height:calc(100dvh - 32px); padding:0; }
.sp-access-dialog-header { display:flex; align-items:center; gap:8px; padding:12px 12px 0 24px; }
.sp-access-dialog-header h2 { flex:1; margin:0; }
/* An icon control, not an action role: no surface or border of its own. */
.sp-access-close { width:44px; height:44px; display:grid; place-items:center; padding:0; color:var(--sp-text); background:transparent; border-color:transparent; }
.sp-access-close:hover { background:color-mix(in oklch,transparent,var(--sp-text) 8%); }
.sp-access-close svg { width:20px; height:20px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; }
.sp-access-dialog [data-sempods-access] { padding:8px 24px 24px; text-align:start; }
.sp-access-dialog [data-sempods-access] .sp-access-content { max-width:none; }
.sp-access-dialog [data-sempods-access] .sp-access-actions { justify-content:flex-start; margin-inline-start:-14px; }
/* On a phone, management is a bottom sheet, like an app's own small-screen dialog. */
@media (max-width:30rem) {
  .sp-access-dialog { width:100%; max-width:none; margin:auto 0 0; max-height:calc(100dvh - 16px); border-end-start-radius:0; border-end-end-radius:0; padding-block-end:env(safe-area-inset-bottom); }
}
`;
