// Shared helpers of the Find tests in client-sdk and app-sdk; no tests here.
import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import {
  bearer,
  createPod,
  type FindOptions,
  type PodAuth,
  type PodFetch,
} from './index.js';

export { FIND_RESULT } from './find.js';

export const jsonLd = (body: unknown, type = 'application/ld+json') =>
  new Response(JSON.stringify(body), { headers: { 'content-type': type } });

/** A Pod at `base` that answers every request with `body`. */
export function answering(body: unknown, base = 'https://pod.example') {
  const fetch = vi.fn<PodFetch>(async () => jsonLd(body));
  return { fetch, pod: createPod(base, { auth: bearer('test'), fetch }) };
}

/** The JSON body of the `call`-th request. */
export const sent = (fetch: ReturnType<typeof vi.fn<PodFetch>>, call = 0) =>
  JSON.parse(String(fetch.mock.calls[call]?.[1]?.body)) as unknown;

/** The body of an `ok` result; any other kind fails the test. */
export async function ok<T>(
  answer: Promise<{ readonly kind: string; readonly body?: T }>,
): Promise<T> {
  const result = await answer;
  if (result.kind !== 'ok') throw new Error(result.kind);
  return result.body as T;
}

/** The rejection of an answer that cannot be trusted. */
export const bodyRejected = {
  reason: { code: 'response', problem: 'body' },
} as const;

/**
 * An answer with its blank-node labels renamed by first appearance, so two
 * answers of the same data compare equal although each answer has its own.
 */
export function stable(answer: unknown): unknown {
  const names = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(answer).replace(/_:a[0-9a-f]+-[^"]+/g, (label) => {
      if (!names.has(label)) names.set(label, `_:${names.size}`);
      return names.get(label)!;
    }),
  ) as unknown;
}

/** A bearer whose one renewal replaces `old` with `new`. */
export function renewing(): PodAuth {
  let credential = { authorization: 'Bearer old' };
  return {
    credential: async () => credential,
    renew: async () => {
      credential = { authorization: 'Bearer new' };
      return true;
    },
  };
}

export interface FindRepresentation {
  readonly jsonld: unknown;
  readonly nquads: string;
}
/** One shared Find case (sempods-spec#147, examples/find/responses.yaml). */
export interface FindCase {
  readonly case?: number;
  readonly request: {
    readonly text: string;
    readonly type?: readonly string[];
    readonly contexts?: readonly string[];
    readonly limit?: number;
  };
  readonly grouped?: FindRepresentation;
  readonly flat: FindRepresentation;
  readonly invalid?: { readonly jsonld: unknown };
}

/** The shared cases by name, under the Pod at `base`. */
export function findCases(
  base = 'https://pod.example',
): readonly [string, FindCase][] {
  const text = readFileSync(
    new URL('./fixtures/find-responses.json', import.meta.url),
    'utf8',
  ).replaceAll('https://pod.example/', `${base}/`);
  return Object.entries(JSON.parse(text) as Record<string, FindCase>).filter(
    ([name]) => name !== '$source',
  );
}

/** A case's request members as `FindOptions`. */
export const optionsOf = ({
  type,
  contexts,
  limit,
}: FindCase['request']): FindOptions => ({
  ...(type ? { types: type } : {}),
  ...(contexts ? { contexts } : {}),
  ...(limit === undefined ? {} : { limit }),
});
