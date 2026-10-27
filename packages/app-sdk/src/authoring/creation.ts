import {
  newSubjectIri,
  prepareCreation,
  type Creation,
  type FieldDefinition,
} from '@sempods/client-sdk/edit';
import { changed, started } from './changes.js';
import type { BoundView } from '../runtime/view.js';

/**
 * One creation in a bound target, usable without React; the headless
 * counterpart of `useCreation`. Bind an explicit Context with
 * `runtime.bindContext(connectionId, contextIri)`. It captures a fresh IRI in
 * `collection` and the draft once, as `prepareCreation` does; `run()` counts
 * as a write on that Context, so lists of the same Context read again after a
 * confirmed creation and earlier success feedback there retires.
 */
export function bindCreation<D>(
  view: BoundView,
  definition: FieldDefinition<D>,
  draft: D,
  options: { readonly collection: string },
): Creation {
  const creation = prepareCreation(
    view,
    newSubjectIri(view, options.collection),
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
