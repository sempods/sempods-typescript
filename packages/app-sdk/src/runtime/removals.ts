/**
 * Internal, for the app controller's stores: how often each connection ID of
 * a runtime was removed. A connection the runtime adds again under the same
 * ID (the default Pod read without a token after `forget`, or a record
 * another tab deleted) is another connection: work bound to the earlier one
 * compares this count, not the ID alone (#408). No public API.
 */
export const connectionRemovals = new WeakMap<object, (id: string) => number>();
/** How often `id` was removed from `runtime`; 0 for an unknown runtime. */
export function removalsOf(runtime: object, id: string | null) {
  return id === null ? 0 : (connectionRemovals.get(runtime)?.(id) ?? 0);
}
