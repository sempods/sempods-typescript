import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useApp, useAppState } from './app.js';
import { useSdkLocale } from './locale.js';
import { AccessNotice, endedMessage } from './components.js';
import { contextName, distinctName, podName } from './names.js';
import { knownContexts, reads } from './access-presentation.js';
import type { Connection } from '../runtime/types.js';

/**
 * One access action at a time, its failure and whether the controls are
 * unavailable (a guarded change, its prompt, startup or storage). The control
 * that started an action gets the focus back once it is enabled again: a
 * disabled control loses the focus in WebKit (the focus fixup rule), which
 * stays on the body otherwise (#332).
 */
export function useAccessAction() {
  const state = useAppState();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null);
  const unavailable =
    busy ||
    state.changing ||
    state.confirmingLeave ||
    !state.startup ||
    // Without sign-in nothing is stored, on purpose.
    (state.startup.storage !== 'durable' && state.signIn !== 'none') ||
    Boolean(state.startupError);
  const actionFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const target = actionFocus.current;
    if (unavailable || !target) return;
    actionFocus.current = null;
    // Only a lost focus returns: one the action moved elsewhere stays there.
    const active = target.ownerDocument.activeElement;
    if (target.isConnected && (!active || active === target.ownerDocument.body))
      target.focus();
  }, [unavailable]);
  async function act(task: () => Promise<unknown>) {
    if (inFlight.current || unavailable) return;
    const focused = document.activeElement;
    actionFocus.current =
      focused instanceof HTMLElement && focused !== document.body
        ? focused
        : null;
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
  return { act, unavailable, failure };
}

/** How the app's view uses its Pods; see `AppAccessProps.podView`. */
export type PodView = 'selected' | 'combined';

interface PodAction {
  readonly key: string;
  readonly label: string;
  readonly run: () => Promise<unknown>;
}

/**
 * Management of the connected Pods: one row per connection, its name and
 * marker expanding what this app may do there, and a ⋯ button with the
 * actions for that Pod. Expanding only inspects a Pod; switching is the
 * guarded **Use this Pod** of a single-Pod view. **Connect another Pod**
 * follows the list as an action of the whole dialog.
 */
export function PodManagement({
  mode,
  podNames,
  podView,
  podViewDescription,
  contextRequired,
  switching,
  recheck,
  onAdd,
  focusAdd,
  notice,
}: {
  readonly mode: 'single' | 'multiple';
  readonly podNames?: Readonly<Record<string, string>> | undefined;
  readonly podView: PodView;
  readonly podViewDescription?: ReactNode;
  readonly contextRequired: boolean;
  /** The app selects through its own switch (`useContexts`): no chooser here. */
  readonly switching: boolean;
  /** **Check access** for the active Pod; the dialog checks on opening instead. */
  readonly recheck: boolean;
  readonly onAdd: () => void;
  /** Focus **Connect another Pod** on mounting, coming back from its step. */
  readonly focusAdd: boolean;
  /** `AccessNotice` about the app's target belongs in the active Pod's row. */
  readonly notice: boolean;
}) {
  const app = useApp();
  const state = useAppState();
  const { messages: m, error } = useSdkLocale();
  const id = useId();
  const { act, unavailable, failure } = useAccessAction();
  const combined = podView === 'combined';
  const connections = state.connections;
  const activeId = state.activeId;
  // One Pod shows its details at once; of several, the selected one, until
  // the person opens or closes a row.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const isOpen = (entry: Connection) =>
    toggled.get(entry.id) ??
    (connections.length === 1 ||
      (!combined && entry.id === activeId && reads(entry)));
  const [menu, setMenu] = useState<string | null>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const list = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  // A removed Pod's row goes: its focus moves to the list.
  const removing = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (focusAdd) addButton.current?.focus();
    // Only on mounting, coming back from connecting another Pod.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useLayoutEffect(() => {
    const gone = removing.current;
    if (!gone || connections.some((entry) => entry.id === gone)) return;
    removing.current = null;
    (
      list.current?.querySelector<HTMLElement>('.sp-pod-toggle') ??
      addButton.current
    )?.focus();
  }, [connections]);

  // Details on demand: opening another Pod's row checks its access. The
  // active one's is checked by opening management (dialog), **Check access**
  // (in place) or its discovery demand, so it sends no second request.
  const undiscovered = connections
    .filter(
      (entry) =>
        entry.id !== activeId &&
        isOpen(entry) &&
        reads(entry) &&
        entry.catalogue.kind === 'unknown',
    )
    .map((entry) => entry.id)
    .join(' ');
  useEffect(() => {
    for (const cid of undiscovered ? undiscovered.split(' ') : [])
      void app.refreshContexts(cid).catch(() => {});
  }, [app, undiscovered]);
  function toggle(entry: Connection) {
    const open = !isOpen(entry);
    setToggled(new Map(toggled).set(entry.id, open));
    // A known catalogue is checked again; an unknown one by the effect.
    if (
      open &&
      entry.id !== activeId &&
      reads(entry) &&
      entry.catalogue.kind !== 'unknown' &&
      entry.catalogue.kind !== 'loading'
    )
      void app.refreshContexts(entry.id).catch(() => {});
  }

  const identities =
    state.allowedPods ?? connections.map((entry) => entry.podUrl);
  const nameOf = (entry: Connection) => {
    const index = connections.indexOf(entry) + 1;
    const base = distinctName(entry.podUrl, identities, (value) =>
      podName(value, podNames),
    );
    // Saved connections of one Pod are numbered.
    return connections.filter((other) => other.podUrl === entry.podUrl).length >
      1
      ? `${base} · ${index}`
      : base;
  };
  const markerOf = (entry: Connection) => {
    const s = entry.session;
    if (s.kind === 'restoring') return m.controls.loading;
    if (s.kind === 'ended')
      return s.restorable ? m.controls.unavailable : m.controls.ended;
    if (!combined && entry.id === activeId && reads(entry))
      return m.controls.selected;
    if (s.kind === 'signed-out') return m.controls.signedOut;
    return undefined;
  };
  const actionsOf = (entry: Connection): readonly PodAction[] => {
    const s = entry.session;
    const signIn = state.signIn !== 'none';
    const anonymous = entry.reading === 'anonymous';
    // Any connected Pod can become the selected one, as with the former
    // Pod selector; one that does not read then asks to sign in or retry.
    // A remembered Pod is signed in to instead.
    const remembered =
      (s.kind === 'signed-out' && entry.reading === null) ||
      (s.kind === 'ended' && s.forget === true);
    const use: PodAction[] =
      !combined && entry.id !== activeId && !remembered
        ? [
            {
              key: 'use',
              label: m.controls.usePod ?? m.controls.choosePod,
              run: () => app.selectConnection(entry.id),
            },
          ]
        : [];
    const signInAction: PodAction[] = signIn
      ? [
          {
            key: 'sign-in',
            label: m.controls.signIn,
            run: () => app.authorize(entry.id),
          },
        ]
      : [];
    const signOut: PodAction = {
      key: 'sign-out',
      label: m.controls.disconnectHere ?? m.controls.disconnect,
      run: () => app.disconnect(entry.id),
    };
    // Removing the saved address, not signing out and not revoking access.
    const remove: PodAction[] = signIn
      ? [
          {
            key: 'remove',
            label:
              m.controls.removeSavedPod ??
              m.controls.forget ??
              m.controls.remove,
            run: () => app.forget(entry.id),
          },
        ]
      : [];
    switch (s.kind) {
      case 'active':
      case 'renewing':
        return [
          ...(signIn
            ? [
                {
                  key: 'share',
                  label: m.controls.updateAccess,
                  run: () =>
                    app.authorize(entry.id, { intent: 'change-sharing' }),
                },
              ]
            : []),
          ...use,
          signOut,
        ];
      case 'signed-out':
        // A Pod read without a token that was never signed in to has no
        // saved address of its own to remove.
        return [
          ...signInAction,
          ...use,
          ...(anonymous && s.problem === undefined ? [] : remove),
        ];
      // A Pod still restoring can already be signed out of.
      case 'restoring':
        return [...use, signOut];
      case 'ended':
        if (s.saved === false)
          return [
            {
              key: 'retry',
              label: m.controls.retry,
              run: () =>
                s.forget ? app.forget(entry.id) : app.disconnect(entry.id),
            },
          ];
        if (s.forget) return [];
        if (s.restorable)
          return [
            {
              key: 'retry',
              label: m.controls.retry,
              run: () => app.retryRestore(entry.id),
            },
            ...use,
            signOut,
          ];
        // Reading without a token has no session to sign out of.
        return [...signInAction, ...use, ...(anonymous ? remove : [signOut])];
      default:
        return [];
    }
  };
  // Another Pod can be connected: not in a single-Pod app, not without
  // sign-in and not once every permitted Pod is connected.
  const canAdd =
    mode === 'multiple' &&
    state.signIn !== 'none' &&
    (!state.allowedPods ||
      state.allowedPods.some(
        (target) => !connections.some((entry) => entry.podUrl === target),
      ));

  // A press outside a Pod's actions and their button closes them; one
  // inside is not leaving them, wherever the browser puts the focus.
  const pressing = useRef(false);
  useEffect(() => {
    if (!menu) return;
    // The press that opened them ended before they opened.
    pressing.current = false;
    const head = triggers.current.get(menu)?.parentElement;
    const document = head?.ownerDocument;
    if (!head || !document) return;
    const outside = (event: PointerEvent) => {
      if (!head.contains(event.target as Node | null)) setMenu(null);
    };
    const released = () => {
      pressing.current = false;
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('pointerup', released, true);
    document.addEventListener('pointercancel', released, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('pointerup', released, true);
      document.removeEventListener('pointercancel', released, true);
    };
  }, [menu]);
  function closeMenu(focus: boolean) {
    const open = menu;
    setMenu(null);
    if (focus && open) triggers.current.get(open)?.focus();
  }

  return (
    <div className="sp-pods">
      {combined && podViewDescription && (
        <p className="sp-pods-scope">{podViewDescription}</p>
      )}
      {/* Each Pod is a group named by the Pod, for its name and actions. */}
      <div ref={list} className="sp-pods-list">
        {connections.map((entry) => {
          const rowId = `${id}-${entry.id}`;
          const name = nameOf(entry);
          const marker = markerOf(entry);
          const actions = actionsOf(entry);
          const open = isOpen(entry);
          const s = entry.session;
          const failedSave = s.kind === 'ended' && s.saved === false;
          return (
            <div
              key={entry.id}
              role="group"
              aria-labelledby={`${rowId}-name`}
              className="sp-pod"
            >
              <div
                className="sp-pod-head"
                onPointerDownCapture={() => {
                  pressing.current = true;
                }}
                onBlur={(event) => {
                  // The keyboard leaves the actions. A press on one moves
                  // the focus away in WebKit (to the dialog), which is not
                  // leaving; a press elsewhere is handled above.
                  const next = event.relatedTarget as Node | null;
                  if (
                    menu === entry.id &&
                    !pressing.current &&
                    next &&
                    !event.currentTarget.contains(next)
                  )
                    closeMenu(false);
                }}
              >
                <button
                  type="button"
                  className="sp-pod-toggle"
                  aria-expanded={open}
                  aria-controls={`${rowId}-details`}
                  onClick={() => toggle(entry)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                  <span id={`${rowId}-name`} className="sp-pod-name">
                    {name}
                  </span>
                  {marker && <span className="sp-pod-marker">{marker}</span>}
                </button>
                {actions.length > 0 && (
                  <button
                    type="button"
                    ref={(element) => {
                      if (element) triggers.current.set(entry.id, element);
                      else triggers.current.delete(entry.id);
                    }}
                    className="sp-pod-more"
                    aria-label={m.podActions?.(name) ?? name}
                    title={m.podActions?.(name) ?? name}
                    aria-expanded={menu === entry.id}
                    aria-controls={`${rowId}-actions`}
                    onClick={() => setMenu(menu === entry.id ? null : entry.id)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="5" cy="12" r="1.8" />
                      <circle cx="12" cy="12" r="1.8" />
                      <circle cx="19" cy="12" r="1.8" />
                    </svg>
                  </button>
                )}
                {menu === entry.id && (
                  <PodMenu
                    id={`${rowId}-actions`}
                    label={m.podActions?.(name) ?? name}
                    actions={actions}
                    disabled={unavailable}
                    onClose={() => closeMenu(true)}
                    onRun={(action) => {
                      closeMenu(true);
                      if (action.key === 'remove') removing.current = entry.id;
                      void act(action.run);
                    }}
                  />
                )}
              </div>
              {/* A failed sign-out or removal stays visible, also collapsed. */}
              {failedSave && (
                <p role="alert">
                  {s.forget
                    ? m.controls.forgetFailed
                    : m.controls.disconnectFailed}
                </p>
              )}
              <div
                id={`${rowId}-details`}
                className="sp-pod-details"
                hidden={!open}
              >
                {open && (
                  <PodDetails
                    connection={entry}
                    active={entry.id === activeId}
                    notice={notice && entry.id === activeId}
                    recheck={recheck && entry.id === activeId}
                    podNames={podNames}
                    contextRequired={contextRequired}
                    switching={switching}
                    unavailable={unavailable}
                    act={act}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      {canAdd && (
        <button
          ref={addButton}
          type="button"
          className="sp-pods-add"
          onClick={onAdd}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {m.controls.connectAnother}
        </button>
      )}
      {failure && <p role="alert">{error(failure.cause)}</p>}
    </div>
  );
}

/** The actions for one Pod, below its ⋯ button. Escape closes them. */
function PodMenu({
  id,
  label,
  actions,
  disabled,
  onClose,
  onRun,
}: {
  readonly id: string;
  readonly label: string;
  readonly actions: readonly PodAction[];
  readonly disabled: boolean;
  readonly onClose: () => void;
  readonly onRun: (action: PodAction) => void;
}) {
  const group = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    group.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);
  return (
    <div
      ref={group}
      id={id}
      role="group"
      aria-label={label}
      className="sp-pod-menu"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        // Closes these actions, not the dialog around them.
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      {actions.map((action) => (
        <button
          key={action.key}
          type="button"
          disabled={disabled}
          onClick={() => onRun(action)}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

/**
 * What this app may do in one Pod: its address beside a display name, its
 * Contexts with **Read only** or **Can edit**, and whether they are loading,
 * unavailable or none. For the active Pod a Context flow's selection stays
 * here, as before.
 */
function PodDetails({
  connection: c,
  active,
  notice,
  recheck,
  podNames,
  contextRequired,
  switching,
  unavailable,
  act,
}: {
  readonly connection: Connection;
  readonly active: boolean;
  readonly notice: boolean;
  readonly recheck: boolean;
  readonly podNames?: Readonly<Record<string, string>> | undefined;
  readonly contextRequired: boolean;
  readonly switching: boolean;
  readonly unavailable: boolean;
  readonly act: (task: () => Promise<unknown>) => Promise<void>;
}) {
  const app = useApp();
  const state = useAppState();
  const { messages: m } = useSdkLocale();
  const s = c.session;
  // A display name never replaces the address its actions target.
  const address = podNames?.[c.podUrl]?.trim() && (
    <p className="sp-access-address">{c.podUrl}</p>
  );
  if (s.kind === 'restoring')
    return (
      <>
        {address}
        <p role="status">{m.controls.loading}</p>
      </>
    );
  if (!reads(c))
    return (
      <>
        {address}
        {s.kind === 'ended' && s.saved !== false && !s.forget && (
          <p className="sp-access-hint">{endedMessage(s, m, true)}</p>
        )}
        {s.kind === 'signed-out' &&
          s.problem !== undefined &&
          s.problem !== 'disconnected' && (
            <p className="sp-access-hint">{m.controls.sessionEnded}</p>
          )}
        {s.kind === 'signed-out' && state.signIn !== 'none' && (
          <p className="sp-access-hint">{m.controls.signInToSee}</p>
        )}
      </>
    );
  const anonymous = c.reading === 'anonymous';
  const fixedContext =
    state.preset?.podUrl === c.podUrl ? state.preset?.contextIri : undefined;
  // A reload keeps the earlier Contexts on screen until it settles.
  const readable = (knownContexts(c.catalogue) ?? []).filter(
    (entry) => entry.readable,
  );
  const labels =
    c.catalogue.kind !== 'unknown' ? c.catalogue.labels : undefined;
  const contextLabel = (iri: string) =>
    distinctName(
      iri,
      readable.map((entry) => entry.iri),
      (value) => contextName(value, labels),
    );
  const fact = (entry: { readonly writable: boolean }) => (
    <span className="sp-access-fact">
      {entry.writable ? m.controls.canChange : m.controls.canRead}
    </span>
  );
  const selectedEntry = active
    ? readable.find((entry) => entry.iri === c.selectedContext)
    : undefined;
  // The active Pod's selection, while a Context flow needs one.
  const selecting = active && contextRequired && !fixedContext;
  const named =
    readable.length === 1 && selectedEntry
      ? selectedEntry
      : switching
        ? selectedEntry
        : undefined;
  // The row names a failed or pending catalogue itself; the notice adds what
  // else limits the app's target, such as missing feature access.
  const ownStatus =
    c.catalogue.kind === 'failed' || !knownContexts(c.catalogue);
  return (
    <>
      {address}
      {notice && (c.missingRequiredScopes.length > 0 || !ownStatus) && (
        <AccessNotice />
      )}
      {active && contextRequired && fixedContext && (
        <p>
          {m.dataContext}: {contextLabel(fixedContext)}
        </p>
      )}
      {selecting && named ? (
        <p className="sp-access-context">
          {contextLabel(named.iri)}
          {' · '}
          {fact(named)}
        </p>
      ) : selecting && switching && !c.selectedContext ? (
        readable.length > 0 && <p role="status">{m.controls.loading}</p>
      ) : selecting ? (
        <label>
          {m.dataContext}
          <select
            aria-label={m.dataContext}
            value={c.selectedContext ?? ''}
            disabled={
              unavailable ||
              c.catalogue.kind !== 'ready' ||
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
          {selectedEntry && fact(selectedEntry)}
        </label>
      ) : (
        !fixedContext &&
        readable.length > 0 && (
          // What the catalogue says this app may do in each readable Context:
          // caller-relative rights, not which grant or public access gave them.
          <ul
            className="sp-access-contexts"
            aria-label={m.controls.contextAccess}
          >
            {readable.map((entry) => (
              <li key={entry.iri}>
                <span>{contextLabel(entry.iri)}</span>
                {fact(entry)}
              </li>
            ))}
          </ul>
        )
      )}
      {(c.catalogue.kind === 'unknown' ||
        (c.catalogue.kind === 'loading' && !c.catalogue.contexts)) && (
        <p role="status">{m.cataloguePending}</p>
      )}
      {c.catalogue.kind === 'ready' &&
        !fixedContext &&
        readable.length === 0 && (
          <p role="status">
            {anonymous && state.signIn !== 'none'
              ? (m.controls.noPublicData ?? m.noContexts)
              : m.noContexts}
          </p>
        )}
      {c.catalogue.kind === 'failed' && <p role="alert">{m.catalogueError}</p>}
      {(recheck || c.catalogue.kind === 'failed') && (
        <div className="sp-access-actions">
          <button
            type="button"
            disabled={unavailable}
            onClick={() => void act(() => app.refreshContexts(c.id))}
          >
            {m.controls.checkAccess}
          </button>
        </div>
      )}
    </>
  );
}
