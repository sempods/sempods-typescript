import type { Creation } from '@sempods/client-sdk/edit';
import { Lane, type LaneScope, type MutationOutcome } from './lane.js';

/** A creation captured for sending: its draft and its command (IRI, body). */
export interface Captured<D> {
  readonly draft: D;
  readonly creation: Creation;
  /** Held for an explicit retry under the same IRI after observed absence. */
  readonly retry: boolean;
  /** Created, acknowledged as present or discarded: never sent again. */
  readonly settled: boolean;
}
/** Only the lane changes these, on the one object every form refers to. */
type Recovery = { -readonly [K in 'retry' | 'settled']: boolean };

/**
 * Internal: the write lane of one creation form name (see `useCreation`'s
 * `id`), owned by the app controller. Besides the write itself it owns the
 * captured creation and its recovery, so every form of that name, also one
 * hidden, shown again or remounted, shows the same open creation and none
 * sends it afresh:
 *
 * - `capture` records the draft and command a form is about to send; sending
 *   it again (a retry, or after a failure) reuses the same IRI and body.
 * - A confirmed creation settles it.
 * - Acknowledging a checked unresolved creation (`resolve`) holds it for an
 *   explicit retry when the Pod showed it absent, and settles it when present.
 * - Discarding on leave settles it.
 *
 * It imports nothing from React, so a headless host can drive it too.
 */
export class CreationLane<D> extends Lane<D> {
  captured: Captured<D> | null = null;

  /** Records what a form is about to send; returns the captured creation. */
  capture(draft: D, creation: Creation): Captured<D> {
    this.captured = { draft, creation, retry: false, settled: false };
    return this.captured;
  }
  /** The open creation every form of this name shows, locked, if any. */
  open(): Captured<D> | null {
    const captured = this.captured;
    return captured && (this.pending || this.unresolved || captured.retry)
      ? captured
      : null;
  }
  /**
   * Acknowledges a checked unresolved creation: held for a same-IRI retry when
   * absent, settled when present (the original write may still land, so an
   * absent one is never given up silently).
   */
  resolve() {
    if (!this.isChecked()) return;
    const captured = this.captured;
    if (this.absent && captured) (captured as Recovery).retry = true;
    else this.settle();
    this.acknowledge();
  }
  outstanding() {
    return super.outstanding() || Boolean(this.captured?.retry);
  }
  guard(scope: LaneScope) {
    const guard = super.guard(scope);
    return {
      ...guard,
      // A creation held for a retry asks before it is left, too.
      dirty: () => guard.dirty() || Boolean(this.captured?.retry),
      discard: () => {
        this.settle();
        guard.discard();
      },
    };
  }
  notice(starts: number) {
    return { ...super.notice(starts), onAcknowledge: () => this.resolve() };
  }
  protected onOutcome(outcome: MutationOutcome<D>) {
    if (outcome.kind === 'created') this.settle();
  }
  /** The captured creation is done: marked settled (forms that sent it reset). */
  private settle() {
    if (this.captured) (this.captured as Recovery).settled = true;
    this.captured = null;
  }
}
