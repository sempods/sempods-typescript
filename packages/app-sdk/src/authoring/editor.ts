import {
  createResourceEditor,
  type fields,
  type EditDefinition,
  type ResourceEditor,
} from '@sempods/client-sdk/edit';
import { changed } from './changes.js';
import type { BoundView } from '../runtime/view.js';

/** One editor lifetime bound to the runtime's access facts, usable without React. */
export function bindResourceEditor<
  F extends ReturnType<typeof fields<Record<never, never>>>,
>(
  view: BoundView,
  iri: string,
  definition: F,
): ResourceEditor<ReturnType<F['read']>, Partial<ReturnType<F['read']>>>;
export function bindResourceEditor<D>(
  view: BoundView,
  iri: string,
  definition: EditDefinition<D>,
): ResourceEditor<D>;
export function bindResourceEditor<D>(
  view: BoundView,
  iri: string,
  definition: EditDefinition<D>,
): ResourceEditor<D> {
  const editor = createResourceEditor(view, iri, definition);
  let previous = view.getSnapshot();
  editor.setAccess(previous);
  const unsubscribe = view.subscribe(() => {
    const next = view.getSnapshot();
    editor.setAccess(next);
    if (
      next.current &&
      next.read &&
      (!previous.read || next.revision !== previous.revision)
    ) {
      // The editor runs a refresh requested during a read or write once
      // afterwards, so a dispatched write keeps its outcome and regained access
      // or a newer revision still leads to one fresh read.
      void editor.refresh();
    }
    previous = next;
  });
  return {
    ...editor,
    get state() {
      return editor.state;
    },
    async save() {
      const result = await editor.save();
      if (result.kind === 'saved') changed(view);
      return result;
    },
    async remove() {
      const result = await editor.remove();
      if (result.kind === 'removed') changed(view);
      return result;
    },
    dispose() {
      unsubscribe();
      editor.dispose();
    },
  };
}
