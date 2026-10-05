/** Portable protocol failures. App/session recovery belongs to app-sdk. */
export type SdkFailure =
  | import('./oauth/errors.js').OAuthFailure
  | { readonly code: 'invalid-pod-url' }
  /** Programming misuse: an argument the client refuses before any request. */
  | {
      readonly code: 'invalid-argument';
      readonly argument: 'iri' | 'context' | 'query' | 'condition';
    }
  | {
      readonly code: 'discovery';
      readonly stage: 'challenge' | 'resource' | 'authorization-server';
      readonly problem:
        | 'identity-mismatch'
        | 'invalid-metadata'
        | 'unsupported-flow'
        | 'http'
        | 'network'
        | 'cancelled';
      readonly field?: string;
      readonly status?: number;
    }
  /** The context catalogue response does not have the canonical registry shape. */
  | { readonly code: 'catalogue' }
  /** The credential owner failed before a request was dispatched. */
  | { readonly code: 'authentication' }
  /** No answer was received (network failure or cancellation after dispatch). */
  | { readonly code: 'transport'; readonly problem: 'network' | 'cancelled' }
  /** An answered status the operation does not define as an expected outcome. */
  | { readonly code: 'http'; readonly status: number }
  /** An answer was seen but cannot be trusted or decoded. */
  | {
      readonly code: 'response';
      readonly problem: 'redirected' | 'content-type' | 'etag' | 'body';
    }
  | { readonly code: 'unexpected' };

export class SdkError extends Error {
  constructor(
    readonly reason: SdkFailure,
    diagnostic: string,
    options?: ErrorOptions,
  ) {
    super(diagnostic, options);
    this.name = 'SdkError';
  }
}

/** Stable presentation facts; diagnostics and causes are not translated user text. */
export function sdkFailure(cause: unknown): SdkFailure {
  return cause instanceof SdkError ? cause.reason : { code: 'unexpected' };
}
