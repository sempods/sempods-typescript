import { SdkError, type SdkFailure } from '@sempods/client-sdk';
import { SessionTransitionError } from '../sessions/records.js';
import type { SessionTransitionProblem } from '../sessions/types.js';
import { SessionStorageError } from '../sessions/store.js';
import { OAuthError, type OAuthProblem } from '@sempods/client-sdk/oauth';

export type RuntimeProblem =
  | OAuthProblem
  | 'storage'
  | 'busy'
  | 'coordination'
  | 'disconnected'
  | 'expired'
  | 'interrupted'
  | 'discovery'
  | 'request'
  | SessionTransitionProblem
  | 'unexpected';
/** Session/coordinator failures are runtime facts, separate from portable protocol failures. */
export class RuntimeError extends Error {
  constructor(readonly problem: RuntimeProblem) {
    super(`Browser runtime: ${problem}.`);
    this.name = 'RuntimeError';
  }
}
export function runtimeProblem(error: unknown): RuntimeProblem {
  if (error instanceof RuntimeError || error instanceof OAuthError)
    return error.problem;
  if (error instanceof SessionStorageError) return 'storage';
  if (error instanceof SessionTransitionError) return error.problem;
  if (error instanceof SdkError) {
    const reason = error.reason;
    if (reason.code === 'invalid-pod-url' || reason.code === 'invalid-argument')
      return 'configuration';
    if (reason.code === 'transport') return reason.problem;
    if (reason.code === 'discovery') {
      if (reason.problem === 'network' || reason.problem === 'cancelled')
        return reason.problem;
      return 'discovery';
    }
    return reason.code === 'unexpected' ? 'unexpected' : 'request';
  }
  return 'unexpected';
}

/** Copy only the structured protocol reason; never attach Error/cause/response objects. */
export function runtimeFailure(error: unknown): {
  readonly failure?: SdkFailure;
} {
  return error instanceof SdkError
    ? { failure: Object.freeze({ ...error.reason }) }
    : {};
}

/**
 * Failures before a refresh claim that may pass on the next attempt: an
 * unreachable or failing Pod, or storage that could not be written. Changed
 * bindings, invalid metadata, unreadable records and a closed store are
 * permanent.
 */
export function transientBeforeClaim(error: unknown): boolean {
  // A closed store, or none at all, stays so for this runtime; only a store
  // that could not complete a write may succeed next time.
  if (error instanceof SessionStorageError)
    return error.problem === 'unavailable';
  if (!(error instanceof SdkError)) return false;
  const reason = error.reason;
  if (reason.code === 'transport') return reason.problem === 'network';
  if (reason.code !== 'discovery') return false;
  if (reason.problem === 'network') return true;
  return (
    reason.problem === 'http' &&
    (reason.status === undefined ||
      reason.status >= 500 ||
      reason.status === 408 ||
      reason.status === 429)
  );
}
