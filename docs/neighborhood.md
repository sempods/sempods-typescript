# Show the statements around a resource

Use this guide when an app lists what the Pods say about one resource: its
properties, what links to it, or its neighbors in a graph. The list loads page
by page. One frequent predicate can fill a whole page: 50 times `follows`, and
nothing else is visible. The recipe then adds a few examples of the other
predicates.

Copy and adapt the recipe:

- [`neighborhood.ts`](../examples/todo/recipes/neighborhood.ts): the queries
  and the merge, without React.
- [`neighborhood-view.tsx`](../examples/todo/recipes/neighborhood-view.tsx):
  `useNeighborhood`, and `NeighborhoodList` as a placeholder for the app's own
  view.

## Use it

Set `podReadLimit` on the runtime
([bounded Pod reads](browser-runtime.md#bounded-pod-reads)), then read the
statements around a resource:

```tsx
const { statements, examples, sources, readers } = useNeighborhood(
  runtime,
  root,
  hidden ? { hidden, priority: 'current' } : { priority: 'current' },
);
```

- `readers` renders nothing. Render it once.
- `statements` are the pages read so far.
- `examples` are a few statements of other predicates. Show them apart from
  the pages.
- `sources` has one entry per Pod and direction, with `loadMore`, `retry`
  and `retrySample`. Where these controls go is up to the app.

## Pages and examples

Each Pod is read in two directions: `out` (the resource is the subject) and
`in` (it is the object). A page has 50 statements. The app calls `loadMore`
for the next one.

Only a full first page gets a sample, in two requests:

1. Find up to 16 predicates that the first page does not show.
2. Read up to 3 statements of each.

Each predicate has its own limit, so a frequent one cannot crowd out the
others. The sample never changes the pages, and loading more pages never
starts a new sample.

Examples are not complete. They show that other predicates exist.
`morePredicates` says that there are more than 16. Only the pages are
complete, once the last page is not full. A statement that a later page
holds shows once, as a page statement. When all pages are read, the examples
and `morePredicates` are gone.

## Hidden Contexts

Pass the Contexts to hide as `hidden`. Both sample requests leave them out
before their limits, so hidden data never uses them up. The pages are not
read again; hidden statements just disappear.

## Where each statement comes from

Each statement keeps its Pod, Context, direction, predicate and the exact
term of the other end. The same statement in two Contexts or two Pods is two
statements. A blank node counts only within one read: until all pages are
read, its example can appear next to the same statement on a page.

## Reads

Each page and each sample is its own `usePodLoad` with the connection's
`BoundPod`. So:

- reads wait for the runtime's limit,
- a failed sample leaves the pages usable, and each read retries alone,
- a Pod that signs out, loses access or changes its grants takes its
  statements with it in the same render,
- a new resource cancels the old reads; their late answers never show.

## Limits

- Change `PAGE_SIZE`, `MAX_PREDICATES` and `MAX_EXAMPLES` in your copy.
- The sort order decides which statements become examples.
- Tested with the Oxigraph SPARQL engine and two fixture Pods in jsdom, not
  with a real Pod.
