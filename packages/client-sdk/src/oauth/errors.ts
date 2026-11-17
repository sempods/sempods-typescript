import { SdkError } from '../errors.js';

/**
 * Why an OAuth step failed. An authorization callback that the provider answered
 * with an error bound to the attempt (issuer and state checked) is classified by
 * its error code; the provider's free-text description is never kept, and its
 * `error_uri` only on the issuer's origin (`OAuthFailure.providerLink`).
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
  /**
   * The provider's `error_uri` of an authorization error answer bound to the
   * attempt, for example a link to its own login page: kept only when it has
   * the issuer's origin and no user information, so it never leads anywhere
   * the person was not about to go for signing in. Its free text
   * (`error_description`) is never kept.
   */
  readonly providerLink?: string;
}
/** Safe protocol diagnostics: no token, callback URL, response or raw cause. */
export class OAuthError extends SdkError {
  constructor(
    readonly problem: OAuthProblem,
    field?: string,
    status?: number,
    stage: OAuthFailure['stage'] = 'authorization',
    providerLink?: string,
  ) {
    super(
      {
        code: 'oauth',
        stage,
        problem,
        ...(field === undefined ? {} : { field }),
        ...(status === undefined ? {} : { status }),
        ...(providerLink === undefined ? {} : { providerLink }),
      },
      `OAuth ${stage}: ${problem}.`,
      { cause: undefined },
    );
    this.name = 'OAuthError';
  }
}
