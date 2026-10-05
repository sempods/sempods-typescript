import { expectTypeOf, it } from 'vitest';
import type {
  AuthCredential,
  ContextView,
  GetResult,
  JsonLd,
  PodAuth,
  WriteResult,
} from './index.js';

it('lets a fixed bearer satisfy the authentication seam without renewal', () => {
  const token: AuthCredential = { authorization: 'Bearer example' };
  const bearer: PodAuth = {
    credential: async () => token,
    renew: async () => false,
  };
  expectTypeOf(bearer).toEqualTypeOf<PodAuth>();
});

it('offers a validator only after a successful read', () => {
  type Ok = Extract<GetResult<JsonLd>, { kind: 'ok' }>;
  expectTypeOf<Ok['etag']>().toEqualTypeOf<string>();
  function noEtagBeforeNarrowing(read: GetResult<JsonLd>) {
    // @ts-expect-error `etag` exists only on `ok`.
    return read.etag;
  }
  void noEtagBeforeNarrowing;
});

it('keeps decided-before-dispatch and unknown outcomes apart', () => {
  type Kind = WriteResult['kind'];
  expectTypeOf<'not-sent'>().toExtend<Kind>();
  expectTypeOf<'uncertain'>().toExtend<Kind>();
  function safeToRetry(result: WriteResult): boolean {
    // Only `not-sent` guarantees nothing reached the Pod.
    return result.kind === 'not-sent';
  }
  void safeToRetry;
});

it('requires an explicit condition or overwrite for every change', () => {
  function writes(
    view: ContextView,
    read: Extract<GetResult<JsonLd>, { kind: 'ok' }>,
  ) {
    void view.subjects.patch('urn:x', {}, { ifMatch: read.etag });
    void view.subjects.put('urn:x', {}, { ifNoneMatch: '*' });
    void view.subjects.delete('urn:x', { overwrite: true });
    // @ts-expect-error An unconditional change must be spelled out.
    void view.subjects.patch('urn:x', {}, {});
  }
  void writes;
});
