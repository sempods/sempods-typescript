/** Standard Fetch policy fields missing from some Node RequestInit declarations. */
export type PodRequestInit = RequestInit & {
  readonly cache?: 'no-store';
  readonly referrerPolicy?: 'no-referrer';
};

/** Trusted override; must honor the supplied credential, redirect and cancellation policy. */
export type PodFetch = (
  url: string,
  init?: PodRequestInit,
) => Promise<Response>;
