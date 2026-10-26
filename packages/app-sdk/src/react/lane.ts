import { sdkFailure } from '@sempods/client-sdk';
import type {
  CreateOutcome,
  FieldDefinition,
  RemoveSnapshotOutcome,
  UpdateOutcome,
} from '@sempods/client-sdk/edit';
import type { AppController, LeaveGuard } from '../authoring/app.js';
import { changed, started, succeeded } from '../authoring/changes.js';
import type { BoundView } from '../runtime/view.js';

export type MutationOutcome<D> =
  UpdateOutcome<D> | RemoveSnapshotOutcome<D> | CreateOutcome;

/** Keep the write outcome while dropping observations made under lost read access. */
export function withoutComparison<D>(
  outcome: MutationOutcome<D> | null,
): MutationOutcome<D> | null {
  if (outcome?.kind === 'changed-on-pod')
    return { ...outcome, current: undefined };
  if (outcome?.kind === 'unconfirmed')
    return 'current' in outcome
      ? { ...outcome, current: undefined, desiredObserved: false }
      : { kind: 'unconfirmed' };
  return outcome;
}

/**
 * Internal: one mutation lane for one target. It captures its subject per
 * write; a retired lane (target or definition changed) never updates again.
 * React hooks read its fields when rendering and re-render on `notify`.
 */
export class Lane<D> {
  pending = false;
  unresolved = false;
  checked = false;
  absent = false;
  iri = '';
  version = 0;
  uncertain = false;
  alive = true;
  /**
   * The snapshot a confirmed update was made from. It no longer shows the
   * resource, so it cannot be written again; the next read brings a fresh one.
   */
  spent: object | null = null;
  state: {
    outcome: MutationOutcome<D> | null;
    operation: 'create' | 'update' | 'remove';
    busy: boolean;
    /** The target's start count at this lane's own start. */
    start: number;
  } | null = null;
  evidence: {
    version: number;
    value: D | null;
    /** Present, but the definition cannot read it. */
    unreadable: boolean;
  } | null = null;

  constructor(
    readonly view: BoundView | null,
    private readonly definition: FieldDefinition<D>,
    private readonly app: AppController,
    /** Whether the lane's target is still the one it writes to. */
    private readonly holds: () => boolean,
    private readonly notify: () => void,
  ) {}

  eligible() {
    return this.alive && this.holds();
  }
  readable() {
    return this.eligible() && Boolean(this.view?.getSnapshot().read);
  }
  isChecked() {
    return this.readable() && this.checked;
  }
  /** Read access was lost: observations made under it no longer count. */
  loseRead() {
    this.version++;
    this.checked = false;
    this.absent = false;
    this.evidence = null;
    if (this.state)
      this.state = {
        ...this.state,
        outcome: withoutComparison(this.state.outcome),
      };
    this.notify();
  }
  /** The target or definition changed: the lane never updates again. */
  retire() {
    this.alive = false;
    this.version++;
    this.checked = false;
    this.absent = false;
  }
  guard(scope: 'target' | 'explicit'): LeaveGuard {
    return {
      scope,
      unconfirmed: () => this.uncertain,
      blocked: () => this.pending,
      dirty: () => this.unresolved,
      discard: () => {
        this.unresolved = false;
        this.uncertain = false;
        this.version++;
        this.checked = false;
        if (this.alive) {
          this.state = null;
          this.notify();
        }
      },
    };
  }
  /** Whether a write may start now; `execute` sends nothing otherwise. */
  startable(subject?: object) {
    const view = this.view;
    return Boolean(
      view &&
      (subject === undefined || subject !== this.spent) &&
      this.eligible() &&
      !this.pending &&
      !this.unresolved &&
      view.getSnapshot().write &&
      !this.app.getSnapshot().changing &&
      !this.app.getSnapshot().confirmingLeave,
    );
  }
  async execute(
    operation: 'create' | 'update' | 'remove',
    iri: string,
    action: (target: BoundView) => Promise<MutationOutcome<D>>,
    /** The snapshot written from; a confirmed update spends it. */
    subject?: object,
  ) {
    const view = this.view;
    if (!view || !this.startable(subject)) return;
    const version = ++this.version;
    this.pending = true;
    this.checked = false;
    this.absent = false;
    this.iri = iri;
    const start = started(view);
    this.state = { operation, outcome: null, busy: true, start };
    this.notify();
    let outcome: MutationOutcome<D>;
    try {
      outcome = await action(view);
    } catch (error) {
      const problem = { kind: 'failure' as const, failure: sdkFailure(error) };
      outcome =
        operation === 'create'
          ? { kind: 'not-created', reason: 'failure', problem }
          : operation === 'remove'
            ? { kind: 'not-removed', reason: 'failure', problem }
            : { kind: 'not-saved', reason: 'failure', problem };
    }
    this.pending = false;
    if (!this.eligible()) return;
    if (outcome.kind === 'saved' && subject) this.spent = subject;
    // A result may contain a read made before access was lost and regained.
    if (this.version !== version || !this.readable())
      outcome = withoutComparison(outcome)!;
    this.unresolved =
      outcome.kind === 'unconfirmed' || outcome.kind === 'changed-on-pod';
    this.uncertain = outcome.kind === 'unconfirmed';
    this.state = { operation, outcome, busy: false, start };
    this.notify();
    if (succeeded(outcome)) changed(view);
    return outcome;
  }
  acknowledge() {
    if (!this.eligible() || this.pending) return;
    this.unresolved = false;
    this.uncertain = false;
    this.version++;
    this.checked = false;
    this.absent = false;
    this.state = null;
    this.notify();
  }
  async check() {
    const view = this.view;
    if (!view || !this.readable() || !this.unresolved) return false;
    this.checked = false;
    this.absent = false;
    this.evidence = null;
    this.notify();
    const version = ++this.version;
    try {
      const read = await view.subjects.get(this.iri);
      if (!this.readable() || !this.unresolved || this.version !== version)
        return false;
      if (read.kind !== 'ok' && read.kind !== 'not-found') return false;
      let value: D | null = null;
      let unreadable = false;
      if (read.kind === 'ok')
        try {
          value = this.definition.read(read.body);
        } catch {
          // Still evidence of presence: settling must not depend on mapping it.
          unreadable = true;
        }
      if (!this.readable() || !this.unresolved || this.version !== version)
        return false;
      this.evidence = { version, value, unreadable };
      this.absent = read.kind === 'not-found';
      this.checked = true;
      this.notify();
      changed(view);
      return this.isChecked();
    } catch {
      return false;
    }
  }
  /** Its outcome as shown; a success retires once another write started on the target. */
  outcome(starts: number) {
    const state = this.state;
    return state && !(succeeded(state.outcome) && state.start !== starts)
      ? state.outcome
      : null;
  }
  /** Whether this lane may write now, given the target's write access. */
  canMutate(writable: boolean, subject?: object) {
    return Boolean(
      this.view &&
      writable &&
      (subject === undefined || subject !== this.spent) &&
      this.eligible() &&
      !this.pending &&
      !this.unresolved &&
      !this.app.getSnapshot().changing &&
      !this.app.getSnapshot().confirmingLeave,
    );
  }
  /** The props for `UpdateNotice`. */
  notice(starts: number) {
    const checked = this.isChecked();
    const evidence =
      checked && this.evidence?.version === this.version ? this.evidence : null;
    return {
      outcome: this.outcome(starts),
      /** A successful comparison under uninterrupted read access to this lane. */
      checked,
      current: evidence && !evidence.unreadable ? evidence.value : undefined,
      unreadable: Boolean(evidence?.unreadable),
      onCheck: () => this.check(),
      onAcknowledge: () => {
        if (this.isChecked()) this.acknowledge();
      },
    };
  }
}
