import type { EditDefinition, ResourceEditor } from '@sempods/client-sdk/edit';
import type { AppController, LeaveGuard } from './app.js';
import { navigateRetaining } from './app.js';
import type { BoundView } from '../runtime/view.js';
import { bindResourceEditor } from './editor.js';
import { keepsWork, sameTarget } from './retention.js';

/** At most this many released editors without unsaved work stay per store. */
const IDLE = 20;

/** Which target an editor follows: the selected view, or an explicit one. */
export type EditorTarget = 'selected' | 'explicit';

/** Unsaved work: a draft, a pending write or an open review. */
const busy = (editor: ResourceEditor<unknown>) =>
  editor.state.phase === 'saving' ||
  (editor.state.phase !== 'deleted' &&
    (editor.state.dirty || editor.state.review !== null));

interface Entry {
  readonly view: BoundView;
  readonly iri: string;
  /** The definition's identity, as in the entry's name. */
  readonly shape: string;
  readonly target: EditorTarget;
  readonly scope: LeaveGuard['scope'];
  readonly editor: ResourceEditor<unknown>;
  readonly guard: LeaveGuard;
  holders: number;
  /** Whether its target is still the one it edits. */
  readonly holds: () => boolean;
  /**
   * Its view is no longer current, and only its work (a draft, a pending
   * write, a review) keeps it (`keepsWork`): what a replacing view finds.
   */
  readonly keptForWork: () => boolean;
  /**
   * The draft its leave guard discarded: a release that finds it unchanged
   * lets the editor go, also when it could not drop it (no base after a
   * read loss).
   */
  discarded?: unknown;
  readonly stop: () => void;
}

/**
 * Internal: the resource editors of one controller, by view, subject,
 * definition and guard scope. An editor's lifetime follows its target, not
 * its component: unmounting, hiding (`<Activity>`) or remounting keeps its
 * draft, its pending write with its outcome, its review and its leave guard,
 * and a component claiming the same editor again gets it back. A released
 * editor without unsaved work stays for a while (the most recent `IDLE`), so
 * showing it again does not read afresh. Once its target no longer holds
 * (another selected view, another active connection, or an explicit view no
 * longer current that neither a component uses nor `keepsWork` keeps for
 * its draft, pending write or review), it is disposed and its guard goes. An
 * explicit editor kept that way is found again through the view that
 * replaced its own, and keeps its own view and write authority.
 */
export interface EditorStore {
  claim<D>(
    view: BoundView,
    iri: string,
    key: string,
    definition: EditDefinition<D>,
    scope: LeaveGuard['scope'],
    target: EditorTarget,
  ): {
    readonly editor: ResourceEditor<D>;
    /**
     * Gives it back; `discard` disposes it at once (another definition), also
     * when called again after it was given back.
     */
    readonly release: (discard?: boolean) => void;
  };
  /**
   * Whether an editor for this Context, subject and scope is kept for the
   * active connection, for example one a remounted `useContextEditor`
   * reopens: returning to it leaves nothing. It binds nothing.
   */
  retains(context: string, iri: string, scope: LeaveGuard['scope']): boolean;
  /**
   * The view of an explicit editor kept for its work through access loss
   * (`keepsWork`) for this Context, subject, scope and definition (`key` and
   * `definition` as for `claim`), for a hook that has no current view to
   * claim it with. An editor of another definition is not this one.
   */
  kept<D>(
    context: string,
    iri: string,
    scope: LeaveGuard['scope'],
    key: string,
    definition: EditDefinition<D>,
  ): BoundView | undefined;
  /** Reopen a selected resource, retaining only its own same-view editor guards. */
  reopen(view: BoundView, iri: string, action: () => void): Promise<boolean>;
}

const stores = new WeakMap<AppController, EditorStore>();
export function editorsOf(app: AppController): EditorStore {
  let store = stores.get(app);
  if (store) return store;
  const entries = new Map<string, Entry>();
  // Views and custom definitions by identity: a `fields()` definition is
  // keyed by its structure, any other mapping only matches itself.
  const ids = new WeakMap<object, number>();
  let objects = 0;
  const idOf = (value: object) => {
    let id = ids.get(value);
    if (id === undefined) ids.set(value, (id = ++objects));
    return id;
  };
  const nameOf = (view: BoundView, iri: string, scope: LeaveGuard['scope']) =>
    `${idOf(view)} ${scope ?? 'local'} ${iri}`;
  const remove = (name: string) => {
    const entry = entries.get(name);
    if (!entry) return;
    entries.delete(name);
    entry.stop();
  };
  // Released editors without unsaved work beyond the bound, oldest first.
  const trim = () => {
    const idle = [...entries].filter(
      ([, entry]) => entry.holders === 0 && !busy(entry.editor),
    );
    for (const [name] of idle.slice(0, Math.max(0, idle.length - IDLE)))
      remove(name);
  };
  store = {
    claim<D>(
      view: BoundView,
      iri: string,
      key: string,
      definition: EditDefinition<D>,
      scope: LeaveGuard['scope'],
      target: EditorTarget,
    ) {
      const shape =
        key === 'custom' ? `custom ${idOf(definition as object)}` : key;
      // Work kept through access loss for the same explicit target.
      const kept =
        target === 'explicit'
          ? [...entries].find(
              ([, other]) =>
                other.target === 'explicit' &&
                other.view !== view &&
                sameTarget(other.view, view) &&
                other.iri === iri &&
                other.scope === scope &&
                other.shape === shape &&
                other.keptForWork(),
            )
          : undefined;
      const name = kept?.[0] ?? `${nameOf(view, iri, scope)} ${shape}`;
      let entry = entries.get(name);
      if (entry) {
        // Most recently claimed last, for the bound.
        entries.delete(name);
        entries.set(name, entry);
      } else {
        const connection = app.getSnapshot().activeId;
        // An explicit editor in use stays through read loss and an ended
        // session (its hook retires it on another connection); released, it
        // stays while `keepsWork` keeps its work.
        const holds = () => {
          const snapshot = app.getSnapshot();
          if (snapshot.activeId !== connection) return false;
          if (target === 'selected') return snapshot.view === view;
          return (
            (entries.get(name)?.holders ?? 0) > 0 ||
            keepsWork(app, connection, view, busy(editor))
          );
        };
        const editor = bindResourceEditor(view, iri, definition);
        const guard: LeaveGuard = {
          ...(scope ? { scope } : {}),
          unconfirmed: () => editor.state.review?.kind === 'unconfirmed',
          dirty: () =>
            editor.state.phase !== 'deleted' &&
            (editor.state.dirty || editor.state.review !== null),
          blocked: () => editor.state.phase === 'saving',
          subscribe: (listener) => editor.subscribe(listener),
          discard: () => {
            editor.discard();
            const entry = entries.get(name);
            if (!entry) return;
            if (entry.holders === 0) remove(name);
            else entry.discarded = editor.state.draft;
          },
        };
        const unregister = app.register(guard);
        // Its target ended: it never updates again and its guard goes. A
        // released editor whose work settled counts towards the bound.
        const follow = () => {
          if (!holds()) remove(name);
        };
        const stops = [
          app.subscribe(follow),
          view.subscribe(follow),
          editor.subscribe(() => {
            const own = entries.get(name);
            if (own?.holders !== 0) return;
            // Kept only for its work, which has settled: it goes.
            if (!own.holds()) remove(name);
            else trim();
          }),
        ];
        entry = {
          view,
          iri,
          shape,
          target,
          scope,
          editor: editor as ResourceEditor<unknown>,
          guard,
          holders: 0,
          holds,
          keptForWork: () => {
            if (view.getSnapshot().current) return false;
            // A draft its leave guard discarded is no work any more, also
            // when the editor could not drop it (no base after a read loss).
            const own = entries.get(name);
            const abandoned =
              own !== undefined &&
              'discarded' in own &&
              own.discarded === editor.state.draft;
            return !abandoned && keepsWork(app, connection, view, busy(editor));
          },
          stop: () => {
            stops.forEach((stop) => stop());
            unregister();
            editor.dispose();
          },
        };
        entries.set(name, entry);
      }
      const own = entry;
      own.holders++;
      let released = false;
      return {
        editor: own.editor as ResourceEditor<D>,
        release: (discard = false) => {
          if (!released) {
            released = true;
            own.holders--;
          } else if (!discard) return;
          if (entries.get(name) !== own) return;
          const abandoned =
            'discarded' in own && own.discarded === own.editor.state.draft;
          if (own.holders === 0 && (discard || abandoned || !own.holds()))
            remove(name);
          else trim();
        },
      };
    },
    retains(context: string, iri: string, scope: LeaveGuard['scope']) {
      return [...entries.values()].some(
        (entry) =>
          entry.view.contextIri === context &&
          entry.iri === iri &&
          entry.scope === scope &&
          entry.holds(),
      );
    },
    kept<D>(
      context: string,
      iri: string,
      scope: LeaveGuard['scope'],
      key: string,
      definition: EditDefinition<D>,
    ) {
      const shape =
        key === 'custom' ? `custom ${idOf(definition as object)}` : key;
      for (const entry of entries.values())
        if (
          entry.target === 'explicit' &&
          entry.view.contextIri === context &&
          entry.iri === iri &&
          entry.scope === scope &&
          entry.shape === shape &&
          entry.keptForWork()
        )
          return entry.view;
      return undefined;
    },
    reopen(view, iri, action) {
      const retained = new Set(
        [...entries.values()]
          .filter(
            (entry) =>
              entry.view === view &&
              entry.iri === iri &&
              entry.scope === 'local' &&
              entry.holds(),
          )
          .map((entry) => entry.guard),
      );
      return navigateRetaining(app, action, retained);
    },
  };
  stores.set(app, store);
  return store;
}
