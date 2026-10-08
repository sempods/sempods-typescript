import { SdkError } from '../errors.js';

/**
 * Why an OAuth step failed. An authorization callback that the provider answered
 * with an error bound to the attempt (issuer and state checked) is classified by
 * its error code only; the provider's free-text description is never kept.
 */
export type OAuthProblem =
  | 'configuration'
  | 'attempt'
  /** Forged or malformed callback: not an answer to the attempt. */
  | 'callback'
  /** `access_denied`. */
  | 'denied'
  /** `login_required`: sign in at the provider first. */
  | 'login-required'
  /** `interaction_required`: finish a step at the provider first. */
  | 'interaction-required'
  /** `consent_required`: give consent at the provider first. */
  | 'consent-required'
  /** `temporarily_unavailable` or `server_error`. */
  | 'provider-unavailable'
  /** Any other error code. */
  | 'rejected'
  | 'exchange'
  | 'invalid-client'
  | 'claims'
  | 'invalid-config'
  | 'network'
  | 'cancelled'
  | 'http'
  | 'invalid-response';
export interface OAuthFailure {
  readonly code: 'oauth';
  readonly stage: 'authorization' | 'client-identity';
  readonly problem: OAuthProblem;
  readonly field?: string;
  readonly status?: number;
}
/** Safe protocol diagnostics: no token, callback URL, response or raw cause. */
export class OAuthError extends SdkError {
  constructor(
    readonly problem: OAuthProblem,
    field?: string,
    status?: number,
    stage: OAuthFailure['stage'] = 'authorization',
  ) {
    super(
      {
        code: 'oauth',
        stage,
        problem,
        ...(field === undefined ? {} : { field }),
        ...(status === undefined ? {} : { status }),
      },
      `OAuth ${stage}: ${problem}.`,
      { cause: undefined },
    );
    this.name = 'OAuthError';
  }
}
