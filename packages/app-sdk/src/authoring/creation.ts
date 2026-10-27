import {
  newSubjectIri,
  prepareCreation,
  type Creation,
  type FieldDefinition,
} from '@sempods/client-sdk/edit';
import { changed, started } from './changes.js';
import type { BoundView } from '../runtime/view.js';

/** Choose a generated resource in a collection or one exact subject IRI. */
export type CreationTarget =
  | { readonly collection: string; readonly iri?: never }
  | { readonly iri: string; readonly collection?: never };

/** Internal: also reject ambiguous/missing addresses from JavaScript callers. */
export function creationAddress(
  options: CreationTarget,
): readonly ['collection' | 'iri', string] {
  if (typeof options.collection === 'string' && options.iri === undefined)
    return ['collection', options.collection];
  if (typeof options.iri === 'string' && options.collection === undefined)
    return ['iri', options.iri];
  throw new TypeError('Creation needs exactly one of collection or iri.');
}
/** Internal: allocate only when capturing a new command, never while rendering. */
export function creationIri(view: BoundView, options: CreationTarget): string {
  const [mode, address] = creationAddress(options);
  return mode === 'iri' ? address : newSubjectIri(view, address);
}

/**
 * One creation in a bound target, usable without React; the headless
 * counterpart of `useCreation`. Bind an explicit Context with
 * `runtime.bindContext(connectionId, contextIri)`. It captures a fresh IRI in
 * `collection` (or the exact `iri`) and the draft once, as `prepareCreation`
 * does; `run()` counts
 * as a write on that Context, so lists of the same Context read again after a
 * confirmed creation and earlier success feedback there retires.
 */
export function bindCreation<D>(
  view: BoundView,
  definition: FieldDefinition<D>,
  draft: D,
  options: CreationTarget,
): Creation {
  const creation = prepareCreation(
    view,
    creationIri(view, options),
    definition,
    draft,
  );
  return Object.freeze({
    iri: creation.iri,
    run: async (...args: Parameters<Creation['run']>) => {
      started(view);
      const outcome = await creation.run(...args);
      if (outcome.kind === 'created') changed(view);
      return outcome;
    },
  });
}
