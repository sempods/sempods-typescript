import { catalogueLists } from '../runtime/binding.js';
import type { CatalogueFact } from '../runtime/types.js';

/** Why a Context is not read or written here, before any request. */
export type ContextEditorProblem =
  /** The catalogue does not list the Context as readable. */
  | 'unreadable'
  /** The catalogue could not be loaded. */
  | 'discovery-failed'
  /** The runtime refused the binding, for example another Context than an exact preset's. */
  | 'refused';

/**
 * Internal: why a Context of the active connection is not available here, by
 * the runtime's own authority, for rows already read (`usePodList`,
 * `useContextUpdate`). While the catalogue is not known yet, access is not
 * decided either (`null`); a failed refresh keeps the earlier listing.
 * `useContextEditor` opens a target afresh and needs a successful listing, so
 * it decides by its own, stricter rule.
 */
export function contextProblem(
  catalogue: CatalogueFact | undefined,
  iri: string,
  refused: boolean,
): ContextEditorProblem | null {
  if (refused) return 'refused';
  if (catalogue !== undefined && catalogueLists(catalogue, iri)) return null;
  if (catalogue?.kind === 'failed') return 'discovery-failed';
  const evidence = catalogue !== undefined && 'contexts' in catalogue;
  return evidence ? 'unreadable' : null;
}
