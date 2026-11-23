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
 * unavailable (a guarded change, its prompt, startup or storage). An
 * unguarded action for one connection (a retry, a catalogue check) passes
 * that connection as `scope`: it holds only that connection's controls
 * (`holds`) and reports its failure apart (`failureOf`), as does a guarded
 * action of one connection that holds them all (`row`). The control that
 * started an action gets the focus back once it is enabled again: a disabled
 * control loses the focus in WebKit (the focus fixup rule), which stays on
 * the body otherwise (#332).
 */
export function useAccessAction() {
  const state = useAppState();
  // Each scope's failure; `null` for an action of the whole view.
  const [failures, setFailures] = useState<
    ReadonlyMap<string | null, { cause: unknown }>
  >(() => new Map());
  const inFlight = useRef(new Set<string | null>());
  const [running, setRunning] = useState<ReadonlySet<string | null>>(
    () => new Set(),
  );
  const unavailable =
    running.has(null) ||
    state.changing ||
    state.confirmingLeave ||
    !state.startup ||
    // Without sign-in nothing is stored, on purpose.
    (state.startup.storage !== 'durable' && state.signIn !== 'none') ||
    Boolean(state.startupError);
  // The control that started each running action, by its scope.
  const actionFocus = useRef(new Map<string | null, HTMLElement>());
  useEffect(() => {
    for (const [key, target] of actionFocus.current) {
      if (unavailable || running.has(key) || target.matches(':disabled'))
        continue;
      actionFocus.current.delete(key);
      // Only a lost focus returns: one the action moved elsewhere stays there.
      const active = target.ownerDocument.activeElement;
      if (
        target.isConnected &&
        (!active || active === target.ownerDocument.body)
      )
        target.focus();
    }
  }, [unavailable, running]);
  const report = (key: string | null, failure: { cause: unknown } | null) =>
    setFailures((current) => {
      const next = new Map(current);
      if (failure) next.set(key, failure);
      else next.delete(key);
      return next;
    });
  /**
   * Runs `task`, holding the actions of `scope` (all of them without one).
   * Its failure shows for `row` when given, else for that scope: an action of
   * one Pod that holds the whole view still reports in that Pod's row.
   */
  async function act(
    task: () => Promise<unknown>,
    scope?: string,
    row?: string,
  ) {
    const key = scope ?? null;
    const reported = row ?? key;
    const flights = inFlight.current;
    if (unavailable || flights.has(key)) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused !== document.body)
      actionFocus.current.set(key, focused);
    else actionFocus.current.delete(key);
    flights.add(key);
    setRunning(new Set(flights));
    report(reported, null);
    try {
      await task();
    } catch (cause) {
      report(reported, { cause });
    } finally {
      flights.delete(key);
      setRunning(new Set(flights));
    }
  }
  /** Whether an action scoped to this connection runs. */
  const holds = (scope: string) => running.has(scope);
  /** The failure of the last action of this connection (its `row`). */
  const failureOf = (scope: string) => failures.get(scope) ?? null;
  return {
    act,
    unavailable,
    holds,
    failure: failures.get(null) ?? null,
    failureOf,
  };
}

/** How the app's view uses its Pods; see `AppAccessProps.podView`. */
export type PodView = 'selected' | 'combined';

interface PodAction {
  readonly key: string;
  readonly label: string;
  readonly run: () => Promise<unknown>;
  /** Unguarded and for this Pod alone: it holds only this Pod's actions. */
  readonly own?: boolean;
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
  const { act, unavailable, holds, failure, failureOf } = useAccessAction();
  const combined = podView === 'combined';
  const connections = state.connections;
  const activeId = state.activeId;
  // One Pod shows its details at once; of several, the selected one, until
  // the person opens or closes a row.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  // The Pod the app's single-Pod view uses.
  const isSelected = (entry: Connection) =>
    !combined && entry.id === activeId && reads(entry);
  const isOpen = (entry: Connection) =>
    toggled.get(entry.id) ?? (connections.length === 1 || isSelected(entry));
  const [menu, setMenu] = useState<string | null>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const list = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const shownIds = useRef(connections.map((entry) => entry.id));
  // The row that last held the focus inside the list.
  const focusedRow = useRef<string | null>(null);

  useLayoutEffect(() => {
    // Once the last permitted Pod is connected, the button is gone: the Pod
    // just connected, now selected, takes the focus.
    if (!focusAdd) return;
    const toggles =
      list.current?.querySelectorAll<HTMLElement>('.sp-pod-toggle');
    const active = connections.findIndex((entry) => entry.id === activeId);
    (addButton.current ?? toggles?.[Math.max(active, 0)])?.focus();
    // Only on mounting, coming back from connecting another Pod.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useLayoutEffect(() => {
    // A Pod's row went (removed here or elsewhere): a focus lost with it
    // moves to the list; another row's removal leaves the focus alone.
    const before = shownIds.current;
    const ids = connections.map((entry) => entry.id);
    shownIds.current = ids;
    const held = focusedRow.current;
    if (!held || !before.includes(held) || ids.includes(held)) return;
    focusedRow.current = null;
    const document = list.current?.ownerDocument;
    const focused = document?.activeElement;
    if (focused && focused !== document.body && focused.isConnected) return;
    (
      list.current?.querySelector<HTMLElement>('.sp-pod-toggle') ??
      addButton.current
    )?.focus();
  }, [connections]);

  useEffect(() => {
    // The focus moved on, or a press went, outside the list: a later removal
    // did not take the focus with it.
    const element = list.current;
    const document = element?.ownerDocument;
    if (!element || !document) return;
    const away = (event: Event) => {
      if (!element.contains(event.target as Node | null))
        focusedRow.current = null;
    };
    document.addEventListener('focusin', away, true);
    document.addEventListener('pointerdown', away, true);
    return () => {
      document.removeEventListener('focusin', away, true);
      document.removeEventListener('pointerdown', away, true);
    };
  }, []);

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
    if (isSelected(entry)) return m.controls.selected;
    if (s.kind === 'signed-out') return m.controls.signedOut;
    return undefined;
  };
  // The Pod every start connects under `optional` (`preset`, or the sole
  // allowed Pod).
  const defaultPodUrl =
    state.preset?.podUrl ??
    (state.allowedPods?.length === 1 ? state.allowedPods[0] : undefined);
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
        // The default Pod's own connection, read without a token and never
        // signed in to, has no saved address to remove: every start lists
        // it again, by the Pod address as its ID. Any other Pod added that
        // way is remembered by its address (#372), also one that became the
        // default Pod later.
        return [
          ...signInAction,
          ...use,
          ...(anonymous && s.problem === undefined && entry.id === defaultPodUrl
            ? []
            : remove),
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
              own: true,
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

  // Actions whose row went, or that have none left (a removal elsewhere),
  // close: no button would close them any more.
  const menuEntry =
    menu === null ? undefined : connections.find((entry) => entry.id === menu);
  if (menu !== null && (!menuEntry || actionsOf(menuEntry).length === 0))
    setMenu(null);

  // A press outside a Pod's actions and their button closes them; one
  // inside is not leaving them, wherever the browser puts the focus.
  const pressing = useRef(false);
  useEffect(() => {
    if (!menu) return;
    // Only a press while these actions are open counts.
    pressing.current = false;
    const head = triggers.current.get(menu)?.parentElement;
    const document = head?.ownerDocument;
    if (!head || !document) return;
    const outside = (event: PointerEvent) => {
      if (head.contains(event.target as Node | null)) pressing.current = true;
      else setMenu(null);
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
  /** Closes the open actions, the focus back on their ⋯ button. */
  function closeMenu() {
    const open = menu;
    setMenu(null);
    if (open) triggers.current.get(open)?.focus();
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
          const actionsLabel = m.podActions?.(name) ?? name;
          const held = unavailable || holds(entry.id);
          const ownFailure = failureOf(entry.id);
          return (
            <div
              key={entry.id}
              role="group"
              aria-labelledby={`${rowId}-name`}
              className="sp-pod"
              onFocus={() => {
                focusedRow.current = entry.id;
              }}
            >
              <div
                className="sp-pod-head"
                onKeyDown={(event) => {
                  // Escape closes open actions, also from their ⋯ button
                  // (Shift+Tab), not the dialog around them.
                  if (event.key !== 'Escape' || menu !== entry.id) return;
                  event.preventDefault();
                  event.stopPropagation();
                  closeMenu();
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
                    setMenu(null);
                }}
              >
                <button
                  type="button"
                  className="sp-pod-toggle"
                  aria-expanded={open}
                  aria-controls={`${rowId}-details`}
                  onClick={() => {
                    // The details open or close in place of the actions.
                    if (menu === entry.id) setMenu(null);
                    toggle(entry);
                  }}
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
                    aria-label={actionsLabel}
                    title={actionsLabel}
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
                    label={actionsLabel}
                    actions={actions}
                    disabled={held}
                    onRun={(action) => {
                      closeMenu();
                      void act(
                        action.run,
                        action.own ? entry.id : undefined,
                        entry.id,
                      );
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
              {/* A failed action of this Pod, also one that held the view. */}
              {ownFailure && <p role="alert">{error(ownFailure.cause)}</p>}
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
                    unavailable={held}
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

/** The actions for one Pod, below its ⋯ button; its row closes them on Escape. */
function PodMenu({
  id,
  label,
  actions,
  disabled,
  onRun,
}: {
  readonly id: string;
  readonly label: string;
  readonly actions: readonly PodAction[];
  readonly disabled: boolean;
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
  readonly act: (task: () => Promise<unknown>, scope?: string) => Promise<void>;
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
  const contextLabel = contextLabeler(readable, c.catalogue);
  // A preset's Context is the only one this app uses in its Pod.
  const fixedEntry = fixedContext
    ? readable.find((entry) => entry.iri === fixedContext)
    : undefined;
  // The active Pod's selection, while a Context flow needs one.
  const selecting = active && contextRequired && !fixedContext;
  // A preset Context the catalogue does not list as readable.
  const fixedMissing =
    fixedContext !== undefined && c.catalogue.kind === 'ready' && !fixedEntry;
  // The row names a failed or pending catalogue and a missing preset Context
  // itself; the notice adds what else limits the app's target, such as
  // missing feature access.
  const ownStatus =
    c.catalogue.kind === 'failed' ||
    !knownContexts(c.catalogue) ||
    fixedMissing;
  return (
    <>
      {address}
      {notice && (c.missingRequiredScopes.length > 0 || !ownStatus) && (
        <AccessNotice />
      )}
      {fixedContext && (
        <p className="sp-access-context">
          {m.dataContext}: {contextLabel(fixedContext)}
          {fixedEntry && (
            <>
              {' · '}
              <AccessFact writable={fixedEntry.writable} />
            </>
          )}
        </p>
      )}
      {selecting ? (
        <ContextChoice
          connection={c}
          readable={readable}
          label={contextLabel}
          switching={switching}
          unavailable={unavailable}
          act={act}
        />
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
                <AccessFact writable={entry.writable} />
              </li>
            ))}
          </ul>
        )
      )}
      {(c.catalogue.kind === 'unknown' ||
        (c.catalogue.kind === 'loading' && !c.catalogue.contexts)) && (
        <p role="status">{m.cataloguePending}</p>
      )}
      {fixedMissing && (
        <p role="status">{m.controls.presetContextUnavailable}</p>
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
            onClick={() => void act(() => app.refreshContexts(c.id), c.id)}
          >
            {m.controls.checkAccess}
          </button>
        </div>
      )}
    </>
  );
}

type ReadableContext = NonNullable<ReturnType<typeof knownContexts>>[number];

/**
 * Names the readable Contexts of one Pod apart: a name that another readable
 * Context shares adds the address. Each name is computed and counted once, so
 * a large catalogue stays linear; a Context the catalogue does not list (a
 * preset's) is named on its own.
 */
export function contextLabeler(
  readable: readonly ReadableContext[],
  catalogue: Connection['catalogue'] | undefined,
) {
  const labels =
    catalogue && catalogue.kind !== 'unknown' ? catalogue.labels : undefined;
  const names = new Map(
    readable.map((entry) => [entry.iri, contextName(entry.iri, labels)]),
  );
  const uses = new Map<string, number>();
  for (const label of names.values())
    uses.set(label, (uses.get(label) ?? 0) + 1);
  return (iri: string) => {
    const own = names.get(iri);
    const label = own ?? contextName(iri, labels);
    // Another readable Context has this name; its own entry counts once.
    return (uses.get(label) ?? 0) > (own === undefined ? 0 : 1)
      ? `${label} · ${iri}`
      : label;
  };
}

/** What the catalogue says this app may do in a Context. */
export function AccessFact({ writable }: { readonly writable: boolean }) {
  const { messages: m } = useSdkLocale();
  return (
    <span className="sp-access-fact">
      {writable ? m.controls.canChange : m.controls.canRead}
    </span>
  );
}

/**
 * The active Pod's Context while a Context flow needs one. One readable
 * Context, already selected, is only named: a choice adds nothing; so is the
 * selection of an app-owned switch (`switching`), whose first selection this
 * waits for. Otherwise the person chooses it here.
 */
export function ContextChoice({
  connection: c,
  readable,
  label,
  switching,
  unavailable,
  act,
}: {
  readonly connection: Connection;
  readonly readable: readonly ReadableContext[];
  readonly label: (iri: string) => string;
  readonly switching: boolean;
  readonly unavailable: boolean;
  readonly act: (task: () => Promise<unknown>) => Promise<void>;
}) {
  const app = useApp();
  const { messages: m } = useSdkLocale();
  const selected = readable.find((entry) => entry.iri === c.selectedContext);
  const named = readable.length === 1 || switching ? selected : undefined;
  if (named)
    // Set off below the Pod: the Context this app works in.
    return (
      <p className="sp-access-context">
        {label(named.iri)}
        {' · '}
        <AccessFact writable={named.writable} />
      </p>
    );
  // The app's own switch selects a first Context; this only waits. A kept
  // selection that lost access needs the chooser below instead.
  if (switching && !c.selectedContext)
    return readable.length > 0 ? (
      <p role="status">{m.controls.loading}</p>
    ) : null;
  return (
    <label>
      {m.dataContext}
      <select
        aria-label={m.dataContext}
        value={c.selectedContext ?? ''}
        disabled={
          unavailable || c.catalogue.kind !== 'ready' || readable.length === 0
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
            {label(entry.iri)}
          </option>
        ))}
      </select>
      {selected && <AccessFact writable={selected.writable} />}
    </label>
  );
}
