import type { JsonLd, WriteResult } from '../results.js';
import {
  changedFields,
  isFieldDefinition,
  sameOwnedTerms,
  withFields,
  type EditDefinition,
  type FieldDefinition,
  type FieldsMark,
} from './fields.js';
import {
  fetchResource,
  problemOf,
  writeProblem,
  type EditProblem,
  type Fetched,
  type ResourceSource,
} from './source.js';
import { frozenCopy, merged, sameData, sameNode } from './terms.js';

/**
 * A write needs a decision before anything else is written. `current` is the
 * compared version: `null` when the resource is absent, `undefined` when it
 * could not be read (check again).
 */
export type Review<D> =
  /** The Pod answered 412: someone changed the resource since it was read. */
  | {
      readonly kind: 'changed-on-pod';
      readonly intent: 'save' | 'remove';
      /** What this editor tried to write; `null` for a removal. */
      readonly mine: D | null;
      readonly current: D | null | undefined;
    }
  /** The answer was lost after dispatch; the write may or may not have happened. */
  | {
      readonly kind: 'unconfirmed';
      readonly intent: 'save' | 'remove';
      readonly mine: D | null;
      readonly current: D | null | undefined;
      /** The current version equals `mine`: not proof that this editor wrote it. */
      readonly desiredObserved: boolean;
    };

export interface EditState<D> {
  /**
   * `loading` before the first draft; `ready` to edit and save; `saving` while
   * a write is in flight (editing continues); `review` after a conflict or a
   * lost answer; `blocked` without usable server state; `deleted` after removal.
   */
  readonly phase:
    'loading' | 'ready' | 'saving' | 'review' | 'blocked' | 'deleted';
  /** The person's values; `null` until the first successful read. Never dropped silently. */
  readonly draft: D | null;
  readonly dirty: boolean;
  readonly valid: boolean;
  readonly canSave: boolean;
  readonly canRemove: boolean;
  readonly canDiscard: boolean;
  readonly review: Review<D> | null;
  readonly problem: EditProblem | null;
}

type NotDone = 'not-ready' | EditProblem['kind'];
export type SaveOutcome =
  /**
   * `alongside`: someone changed other fields meanwhile; the save was rebased
   * once onto that version and both changes are kept (field definitions only).
   */
  | { readonly kind: 'saved'; readonly alongside?: true }
  | { readonly kind: 'review' }
  | { readonly kind: 'not-saved'; readonly reason: NotDone };
export type RemoveOutcome =
  | { readonly kind: 'removed' }
  | { readonly kind: 'review' }
  | { readonly kind: 'not-removed'; readonly reason: NotDone };

/** Known access to the editor's target, for example from a runtime catalogue. */
export interface EditAccess {
  readonly read: boolean;
  readonly write: boolean;
}

/** The draft type a definition reads. */
type DraftOfDefinition<F> = F extends { read(resource: JsonLd): infer D }
  ? D
  : never;

/**
 * `U` is what `change()` accepts: a partial draft for a definition created by
 * `fields()` (independent fields), and the complete draft for any other
 * definition, including copies of a `fields()` definition and unions whose
 * variants must not be mixed.
 */
export interface ResourceEditor<D, U = D> {
  readonly iri: string;
  /** The current state; a new object after every change, stable in between. */
  readonly state: EditState<D>;
  /** Settles with the state after the first read, whatever its outcome. */
  readonly loaded: Promise<EditState<D>>;
  subscribe(listener: () => void): () => void;
  /**
   * Changes the draft. With a `fields()` definition only the changed fields are
   * needed (`change({ title })`); they are merged into the current draft. Any
   * other definition replaces the whole draft.
   */
  change(update: U): void;
  /** Conditional save of the current draft against the version it was based on. */
  save(): Promise<SaveOutcome>;
  /** Conditional deletion of the version that was read. */
  remove(): Promise<RemoveOutcome>;
  /** Back to the server version: the compared one in review, else the base. */
  discard(): void;
  /**
   * Reads again. Adopts the server version only when that cannot lose the
   * draft (it is unchanged or equals that version); otherwise opens a review.
   * In review, refreshes the comparison. Requested while a read or write is in
   * flight, it runs once afterwards instead (repeated requests coalesce) and
   * the returned promise settles when that read has finished.
   */
  refresh(): Promise<void>;
  /** Review: keep the draft and base the next save on the compared version. */
  continueFromCurrent(): void;
  /** Losing read access clears server data but keeps the draft; call `refresh()` after regaining it. */
  setAccess(access: EditAccess): void;
  /** Ignores late results. A dispatched write cannot be undone. */
  dispose(): void;
}

type Version<D> = {
  readonly body: JsonLd;
  readonly etag: string;
  readonly data: D;
};
/** The base a draft was derived from; after an unread save only its data is known. */
type Base<D> = { readonly version: Version<D> | null; readonly data: D };
type Compared<D> = Version<D> | 'absent' | null;
type Guard = { readonly alive: () => boolean; readonly fresh: () => boolean };

/**
 * Opens one resource of one target for conservative editing and starts reading
 * it. Saving guards the whole version that was read; there is no automatic
 * merge, and nothing is resent after an unknown outcome.
 */
export function createResourceEditor<
  F extends FieldDefinition<unknown> & FieldsMark,
>(
  source: ResourceSource,
  iri: string,
  definition: F,
): ResourceEditor<DraftOfDefinition<F>, Partial<DraftOfDefinition<F>>>;
export function createResourceEditor<D>(
  source: ResourceSource,
  iri: string,
  definition: EditDefinition<D>,
): ResourceEditor<D>;
export function createResourceEditor<D>(
  source: ResourceSource,
  iri: string,
  definition: EditDefinition<D>,
): ResourceEditor<D, Partial<D>> {
  const listeners = new Set<() => void>();
  let reads = new AbortController();
  let epoch = 0;
  let disposed = false;
  let busy: 'read' | 'write' | null = null;
  // A refresh requested while busy runs once afterwards (coalesced), so a
  // regained access or a newer revision is never lost behind a read or write.
  let again: { promise: Promise<void>; resolve: () => void } | null = null;
  let access: EditAccess = { read: true, write: true };
  let phase: EditState<D>['phase'] = 'loading';
  let base: Base<D> | null = null;
  let draft: D | null = null;
  let review: Review<D> | null = null;
  let compared: Compared<D> = null;
  let problem: EditProblem | null = null;
  const fieldwise = isFieldDefinition(definition) ? definition : null;
  let state = snapshot();

  function valid(): boolean {
    return draft !== null && (definition.valid?.(draft) ?? true);
  }
  function dirty(): boolean {
    return draft !== null && (base === null || !sameData(draft, base.data));
  }
  function writable(): boolean {
    return (
      !disposed &&
      !busy &&
      access.write &&
      phase === 'ready' &&
      base?.version != null
    );
  }
  function snapshot(): EditState<D> {
    return Object.freeze({
      phase: busy === 'write' ? 'saving' : phase,
      draft,
      dirty: dirty(),
      valid: valid(),
      canSave: writable() && dirty() && valid(),
      canRemove: writable(),
      canDiscard:
        !busy &&
        draft !== null &&
        (phase === 'review'
          ? typeof compared === 'object' && compared !== null
          : base !== null && dirty()),
      review,
      problem,
    });
  }
  function emit() {
    if (disposed) return;
    state = snapshot();
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener();
      } catch (error) {
        // A host callback must not unwind an edit outcome or operation cleanup.
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }
  function version(fetched: Fetched & { kind: 'ok' }): Version<D> {
    // A private copy of the whole body: a source may cache and reuse objects.
    const body = frozenCopy(fetched.body);
    return {
      body,
      etag: fetched.etag,
      data: frozenCopy(definition.read(body)),
    };
  }
  /**
   * Runs one transition at a time. `alive`: the editor still exists, so a write
   * outcome is recorded. `fresh`: no read loss since the start, so server data
   * read in this transition may be shown or adopted.
   */
  function exclusive<T>(
    kind: 'read' | 'write',
    idle: T,
    action: (guard: Guard) => Promise<T>,
  ): Promise<T> {
    if (disposed || busy) return Promise.resolve(idle);
    busy = kind;
    emit();
    const started = epoch;
    const alive = () => !disposed;
    const guard = { alive, fresh: () => alive() && epoch === started };
    return action(guard).finally(() => {
      busy = null;
      emit();
      if (again) {
        const waiting = again;
        again = null;
        void refresh().finally(waiting.resolve);
      }
    });
  }
  function read(): Promise<Fetched> {
    return fetchResource(source, iri, reads.signal);
  }
  function refresh(): Promise<void> {
    if (disposed || !access.read || phase === 'deleted')
      return Promise.resolve();
    if (busy) {
      // Settles when the deferred read has finished (or was not needed).
      if (!again) {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => (resolve = r));
        again = { promise, resolve };
      }
      return again.promise;
    }
    return exclusive('read', undefined, async (guard) => {
      const fetched = await read();
      if (!guard.fresh()) return;
      if (review) compare(fetched);
      else adopt(fetched);
    });
  }

  /** Puts a fetched comparison into the review. */
  function compare(fetched: Fetched) {
    if (!review) return;
    let current: D | null | undefined;
    try {
      compared =
        fetched.kind === 'ok'
          ? version(fetched)
          : fetched.kind === 'not-found'
            ? 'absent'
            : null;
      current =
        compared === 'absent'
          ? null
          : compared === null
            ? undefined
            : compared.data;
      problem = fetched.kind === 'problem' ? fetched.problem : null;
    } catch (error) {
      compared = null;
      current = undefined;
      problem = problemOf(error);
    }
    review =
      review.kind === 'unconfirmed'
        ? {
            ...review,
            current,
            desiredObserved:
              current !== undefined &&
              (review.intent === 'remove'
                ? current === null
                : current !== null && sameData(current, review.mine)),
          }
        : { ...review, current };
  }

  /** A read outside review: adopt it when the draft cannot be lost. */
  function adopt(fetched: Fetched) {
    if (fetched.kind === 'problem') {
      problem = fetched.problem;
      if (!base?.version) phase = 'blocked';
      return;
    }
    if (fetched.kind === 'not-found') {
      base = null;
      problem = { kind: 'not-found' };
      phase = 'blocked';
      return;
    }
    let next: Version<D>;
    try {
      next = version(fetched);
    } catch (error) {
      problem = problemOf(error);
      phase = 'blocked';
      return;
    }
    problem = null;
    // Nothing can be lost when the draft is unchanged or already equals this
    // version, e.g. after read access returned (the base was cleared then).
    if (draft === null || !dirty() || sameData(draft, next.data)) {
      draft = next.data;
      base = { version: next, data: next.data };
      phase = 'ready';
      return;
    }
    if (base?.version && next.etag === base.version.etag) {
      // The same version: the draft stays based on what was read.
      phase = 'ready';
      return;
    }
    if (fieldwise && base?.version) {
      // Field definitions: the person's changed fields move onto the newer
      // version when exactly their terms are unchanged there.
      const names = changedFields(fieldwise, draft, base.data);
      if (
        names.length > 0 &&
        sameOwnedTerms(fieldwise, names, base.version.body, next.body)
      ) {
        draft = withFields(names, draft, next.data);
        base = { version: next, data: next.data };
        phase = 'ready';
        return;
      }
    }
    // Otherwise a dirty draft never moves to another version silently, even
    // when the mapped values look equal: the definition may depend on other terms.
    review = {
      kind: 'changed-on-pod',
      intent: 'save',
      mine: draft,
      current: next.data,
    };
    compared = next;
    phase = 'review';
  }

  async function settle<O>(
    guard: Guard,
    result: WriteResult,
    intent: 'save' | 'remove',
    mine: D | null,
    done: () => Promise<O>,
    reviewed: (kind: Review<D>['kind']) => O,
    failed: (reason: NotDone) => O,
  ): Promise<O> {
    switch (result.kind) {
      case 'applied':
        return done();
      case 'precondition-failed':
      case 'uncertain': {
        const kind =
          result.kind === 'uncertain' ? 'unconfirmed' : 'changed-on-pod';
        // The write outcome survives read loss; only a fresh comparison is shown.
        if (guard.alive()) {
          openReview(kind, intent, mine);
          phase = 'review';
          if (access.read && guard.fresh()) {
            const fetched = await read();
            if (guard.fresh()) compare(fetched);
          }
        }
        return reviewed(kind);
      }
      default: {
        const reason = writeProblem(result);
        if (guard.alive()) {
          problem = reason;
          if (reason.kind === 'not-found') {
            base = null;
            phase = 'blocked';
          }
        }
        return failed(reason.kind);
      }
    }
  }
  function openReview(
    kind: Review<D>['kind'],
    intent: 'save' | 'remove',
    mine: D | null,
  ) {
    compared = null;
    review =
      kind === 'unconfirmed'
        ? { kind, intent, mine, current: undefined, desiredObserved: false }
        : { kind, intent, mine, current: undefined };
  }

  let settleLoaded!: () => void;
  const loaded = new Promise<void>((resolve) => (settleLoaded = resolve)).then(
    () => state,
  );
  const editor: ResourceEditor<D, Partial<D>> = {
    iri,
    get state() {
      return state;
    },
    get loaded() {
      return loaded;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    change(update) {
      if (disposed || draft === null || phase === 'deleted') return;
      // A private copy: later changes to the caller's object cannot bypass
      // validation or alter submitted and review evidence.
      // Only independent fields may be merged; anything else is replaced.
      draft = frozenCopy(
        fieldwise && plainObject(draft) && plainObject(update)
          ? ({ ...draft, ...update } as D)
          : (update as D),
      );
      emit();
    },
    save() {
      if (!state.canSave)
        return Promise.resolve({ kind: 'not-saved', reason: 'not-ready' });
      const submitted = draft!;
      const at = base!.version!;
      return exclusive<SaveOutcome>(
        'write',
        { kind: 'not-saved', reason: 'not-ready' },
        async (guard) => {
          // The version and values actually written; a rebase moves both once.
          let onto = at;
          let mine: D = submitted;
          let alongside = false;
          let change: JsonLd;
          // Assigned by the first dispatch; a stopped retry keeps the known 412.
          let result!: WriteResult;
          try {
            for (;;) {
              change = definition.patch(onto.body, mine);
              if (Object.keys(change).length === 0) {
                base = { version: onto, data: mine };
                return saved();
              }
              // A rebased retry is a new request: subscribers notified about the
              // rebase may have revoked access or disposed the editor meanwhile.
              // The known 412 then stands and goes to review; nothing is sent.
              if (
                alongside &&
                (!guard.fresh() || !access.read || !access.write)
              )
                break;
              result = await source.subjects.patch(iri, change, {
                ifMatch: onto.etag,
              });
              // Bounded field rebase: once, only after a confirmed 412, and
              // only when exactly the changed fields' terms are unchanged.
              if (
                result.kind !== 'precondition-failed' ||
                alongside ||
                !fieldwise ||
                !access.read ||
                !access.write ||
                !guard.fresh()
              )
                break;
              const fetched = await read();
              // Access may have changed while reading: a new request needs it now.
              if (!guard.fresh() || !access.write || fetched.kind !== 'ok')
                break;
              const next = safely(() => version(fetched));
              const names = changedFields(fieldwise, submitted, at.data);
              if (
                !next ||
                names.length === 0 ||
                !sameOwnedTerms(fieldwise, names, at.body, next.body)
              )
                break;
              onto = next;
              mine = withFields(names, submitted, next.data);
              alongside = true;
              // The live draft and base follow at once, so no later exit
              // (review, lost answer, refusal) can bring stale values back.
              // The person's edits, including newer typing, stay.
              if (draft !== null)
                draft = withFields(
                  changedFields(fieldwise, draft, at.data),
                  draft,
                  next.data,
                );
              base = { version: next, data: next.data };
              emit();
            }
          } catch (error) {
            if (guard.alive()) problem = problemOf(error);
            return { kind: 'not-saved', reason: problemOf(error).kind };
          }
          function saved(): SaveOutcome {
            return alongside ? { kind: 'saved', alongside } : { kind: 'saved' };
          }
          return settle<SaveOutcome>(
            guard,
            result,
            'save',
            mine,
            async () => {
              if (!guard.alive()) return saved();
              // Success is recorded before, and independently of, the next read.
              base = { version: null, data: mine };
              if (!access.read || !guard.fresh()) {
                phase = 'blocked';
                return saved();
              }
              problem = null;
              // Writes claim no version (SPS-CRUD-030). Newer typing may build
              // on the next read only if it is exactly the description this
              // patch produced; a clean draft needs only the submitted values.
              const fetched = await read();
              if (!guard.fresh()) return saved();
              const exact =
                fetched.kind === 'ok' &&
                sameNode(merged(onto.body, change), fetched.body);
              if (
                fetched.kind === 'ok' &&
                (exact ||
                  (!dirty() &&
                    safely(() =>
                      sameData(definition.read(fetched.body), mine),
                    )))
              ) {
                const next = version(fetched);
                base = { version: next, data: next.data };
                // Newer typing stays; everything else follows the saved version.
                if (fieldwise && draft !== null)
                  draft = withFields(
                    // Compared with what was written, so input after a rebase
                    // stays even if it equals the original submission.
                    changedFields(fieldwise, draft, mine),
                    draft,
                    next.data,
                  );
                phase = 'ready';
              } else if (fetched.kind === 'problem') {
                problem = fetched.problem;
                phase = 'blocked';
              } else {
                // Something else changed it right after: compare, do not adopt.
                openReview('changed-on-pod', 'save', mine);
                compare(fetched);
                phase = 'review';
              }
              return saved();
            },
            () => ({ kind: 'review' }),
            (reason) => ({ kind: 'not-saved', reason }),
          );
        },
      );
    },
    remove() {
      if (!state.canRemove)
        return Promise.resolve({ kind: 'not-removed', reason: 'not-ready' });
      const at = base!.version!;
      return exclusive<RemoveOutcome>(
        'write',
        { kind: 'not-removed', reason: 'not-ready' },
        async (guard) => {
          let result: WriteResult;
          try {
            result = await source.subjects.delete(iri, { ifMatch: at.etag });
          } catch (error) {
            if (guard.alive()) problem = problemOf(error);
            return { kind: 'not-removed', reason: problemOf(error).kind };
          }
          return settle<RemoveOutcome>(
            guard,
            result,
            'remove',
            null,
            async () => {
              if (guard.alive()) {
                base = null;
                problem = null;
                phase = 'deleted';
              }
              return { kind: 'removed' };
            },
            () => ({ kind: 'review' }),
            (reason) => ({ kind: 'not-removed', reason }),
          );
        },
      );
    },
    discard() {
      if (!state.canDiscard) return;
      if (phase === 'review' && typeof compared === 'object' && compared) {
        base = { version: compared, data: compared.data };
        review = null;
        compared = null;
        phase = 'ready';
        problem = null;
      }
      draft = base!.data;
      emit();
    },
    refresh,
    continueFromCurrent() {
      if (disposed || busy || phase !== 'review' || compared === null) return;
      if (compared === 'absent') {
        base = null;
        phase = review?.intent === 'remove' ? 'deleted' : 'blocked';
        problem = phase === 'deleted' ? null : { kind: 'not-found' };
      } else {
        // Field definitions keep only the person's edits; untouched fields
        // take the compared values instead of overwriting them later.
        if (fieldwise && draft !== null && base)
          draft = withFields(
            changedFields(fieldwise, draft, base.data),
            draft,
            compared.data,
          );
        base = { version: compared, data: compared.data };
        phase = 'ready';
        problem = null;
      }
      review = null;
      compared = null;
      emit();
    },
    setAccess(next) {
      if (disposed) return;
      const lost = access.read && !next.read;
      access = { read: next.read, write: next.write };
      if (lost) {
        // Server data is no longer eligible; the person's draft stays.
        epoch++;
        reads.abort();
        reads = new AbortController();
        base = null;
        compared = null;
        if (review) review = { ...review, current: undefined };
        else if (phase !== 'deleted') phase = 'blocked';
        problem = { kind: 'refused', status: 403 };
      }
      emit();
    },
    dispose() {
      disposed = true;
      reads.abort();
      listeners.clear();
    },
  };
  void editor.refresh().then(settleLoaded);
  return editor;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function safely<T>(check: () => T): T | false {
  try {
    return check();
  } catch {
    return false;
  }
}
