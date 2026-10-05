import { SdkError } from '../errors.js';

export type OAuthProblem =
  | 'configuration'
  | 'attempt'
  | 'callback'
  | 'denied'
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
