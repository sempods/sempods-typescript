/**
 * Shared by `createPod` and the browser runtime.
 *
 * The authentication seam between a credential owner and the client's request
 * executor. The owner supplies and renews credentials; only the executor decides
 * whether a request is sent again (at most once, after an answered 401).
 */
export interface PodAuth {
  /**
   * Credential for one dispatch, or `null` for an anonymous request. Always for
   * the identity this mechanism was created for; renewal never switches identity.
   */
  credential(request: AuthRequest): Promise<AuthCredential | null>;
  /**
   * Called after an answered 401 that carried `refused`. Resolves `true` only
   * when a different credential is now available (renewed here, or already
   * replaced by another request), so one resend may succeed. Never resends by
   * itself. Cancelling `challenge.signal` stops waiting for this caller only;
   * a renewal shared with other requests continues.
   */
  renew(refused: AuthCredential, challenge: AuthChallenge): Promise<boolean>;
}

/**
 * Applied as-is; the executor compares credentials by object identity, never by
 * value. An owner returns the same immutable object for as long as a credential
 * is current and publishes a new object only for an accepted replacement; it
 * never allocates a fresh wrapper on each `credential()` call.
 */
export interface AuthCredential {
  readonly authorization: string;
}

export interface AuthRequest {
  /** The constructed Pod endpoint about to be called. */
  readonly url: string;
  readonly signal?: AbortSignal;
}

export interface AuthChallenge {
  /** The 401 response's `WWW-Authenticate` header, if any. */
  readonly wwwAuthenticate: string | null;
  readonly signal?: AbortSignal;
}

/** A fixed bearer token without renewal: one stable credential object for its lifetime. */
export function bearer(token: string): PodAuth {
  const credential: AuthCredential = Object.freeze({
    authorization: `Bearer ${token}`,
  });
  return Object.freeze({
    credential: async () => credential,
    renew: async () => false,
  });
}

/** Unauthenticated requests: only public data is readable. */
export function anonymous(): PodAuth {
  return Object.freeze({
    credential: async () => null,
    renew: async () => false,
  });
}
