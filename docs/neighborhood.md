# Show the neighborhood of a resource

Use this guide when an app shows the statements around one resource across the
person's Pods, as a graph explorer does. A resource with many statements of one
kind fills a whole page with that kind: 50 incoming `follows` statements can
hide that anyone `likes` or `cites` the resource. The recipe keeps the ordinary
pages as they are. When a first page is cut, it adds a few examples of the
other kinds, in two bounded requests.

The recipe uses only public exports:

- `usePodLoad` with one connection's `BoundPod`,
- `podReadLimit` and `priority: 'current'` on the runtime,
- the terms of a SELECT,
- `exactTerm` from the [RDF value recipe](rdf-values.md).

It has no graph renderer and no cache of its own. Copy and adapt it:

- [`neighborhood.ts`](../examples/todo/recipes/neighborhood.ts) has the page
  and sample queries, their decoding and the merge. It has no React
  dependency.
- [`neighborhood-view.tsx`](../examples/todo/recipes/neighborhood-view.tsx)
  reads per connection and direction (`useNeighborhood`). Its
  `NeighborhoodList` is a placeholder for the app's own graph.

## The small path

Set `podReadLimit` on the runtime, for example `{ perPod: 4, total: 8 }`
([bounded Pod reads](browser-runtime.md#bounded-pod-reads)). Then render the
neighborhood of the selected resource. `NeighborhoodList` reads it like this:

```tsx
const { statements, examples, sources, readers } = useNeighborhood(
  runtime,
  root,
  hidden ? { hidden, priority: 'current' } : { priority: 'current' },
);
```

`readers` renders nothing. It mounts one `usePodLoad` per page and sample, so
render it once. `statements` are the ordinary pages. `examples` are the
statements of the sample that no loaded page holds; show them apart from the
pages, as examples. `sources` has one entry per reading connection and
direction, with its state and actions: `loadMore`, `retry` and `retrySample`.
Where the load-more and retry controls go is the app's choice.

## Pages stay ordinary

Each direction of each Pod has its own pages. `out` holds the statements whose
subject is the resource, `in` those whose object it is. `pageQuery` reads 50
statements of every Context, sorted, with one more row to know that the page
is cut. The app may keep its own page query: the sample needs only the
`?g ?p ?other` of the first page.

`loadMore` reads the next page when every page has answered and the last one
was cut. A double click reads one page. The recipe never loads a page on its
own, and examples never move the offset: the next page starts where the last
page stopped, so no statement is skipped.

## Two bounded SELECTs

Only a cut first page gets a sample. Its input is the root, the direction, the
predicates the first page shows and the hidden Contexts of that Pod. Later
pages do not change it, so loading more never starts another sample.

The first query finds up to 16 predicates (`MAX_KINDS`) that the first page
does not show:

```sparql
SELECT DISTINCT ?p WHERE {
  GRAPH ?g { ?other ?p <resource> }
  FILTER(?g NOT IN (<hidden context>))
  FILTER(?p NOT IN (<predicate on the first page>))
} ORDER BY ?p LIMIT 17
```

The second query reads up to three statements (`MAX_EXAMPLES`) of each of
them, in one limited subquery per predicate. A predicate with thousands of
statements cannot crowd out the others:

```sparql
SELECT ?g ?p ?other WHERE {
  { SELECT DISTINCT ?g ?p ?other WHERE {
      VALUES ?p { <likes> }
      GRAPH ?g { ?other ?p <resource> }
      FILTER(?g NOT IN (<hidden context>))
    } ORDER BY ?g ?other LIMIT 3 }
  UNION …
} ORDER BY ?p ?g ?other LIMIT 48
```

A sample sends at most these two requests, and only the first when no
predicate is missing. The first returns at most 17 rows, the second at most 48. There is no count and no download of all neighbors. `sampleOf` applies
the caps again, also to a Pod that ignores the filters or limits.

## Examples are not the neighborhood

A sample shows that other kinds exist, with a few statements each. It is not
the complete list of a kind, and 16 kinds are not every kind: `moreKinds` says
that the Pod has more. Only the ordinary pages are complete, once the last one
is not cut. Present examples as examples, for example as "3 of more" or in
their own group, and keep load more on the pages.

When a later page holds a statement of an example, the statement shows once,
as an ordinary statement. Once the pages of a source are complete, its sample
is no longer shown at all.

## Hidden Contexts

`hidden` lists Contexts by Pod and Context IRI. Both sample queries exclude
them before their limits, so a hidden Context never uses up the 16 kinds or the
three examples. A predicate that the first page shows only in a hidden Context
does not count as shown.

The pages do not change. Hidden statements leave the result in the same render,
and a changed `hidden` reads a new sample for that Pod, no page. An equal
inline array reads nothing again.

## Exact terms and provenance

Each `Statement` keeps:

- `pod` and `context`: the Pod URL and the Context IRI,
- `direction` and `predicate`,
- `other`: the other end as an exact `SparqlTerm`, with its language or
  datatype.

The same statement in two Contexts or two Pods is two statements. Within one
source, a statement on two pages or on a page and in a sample shows once. A
blank node is local to its read: its statements are equal only within that
read, so a blank-node example can show next to the same statement on a later
page until the pages are complete.

## Reads, withdrawal and retry

Every page and every sample is its own `usePodLoad` with the connection's
`BoundPod`, so each goes through the runtime's read admission:

- **Failure.** A failed sample leaves the pages usable; `sample` is `failed`
  and `retrySample` reads it again. A failed page reports `failed`, and
  `retry` reads only the failed pages of that source.
- **Withdrawal.** When a Pod signs out, disconnects or loses read access, its
  statements and examples leave the result. Nothing is kept beyond the
  current reads.
- **Obsolete answers.** A new root, direction or sample input is a new read.
  The old one is cancelled, and its late answer never shows.
- **Limits.** Reads beyond `podReadLimit` wait in `loading`. The selected
  resource reads with `priority: 'current'`.

## Limits and evidence

- The page size and the caps are constants of the recipe. Change them in the
  copy; the bounds above follow.
- Ordering by `?g ?p ?other` decides which statements a page and a sample
  contain. A different order gives other examples, not more.
- Evidence comes from the SDK's tests: the generated queries evaluated by the
  Oxigraph SPARQL engine and decoded by the SDK, and React in jsdom on two
  fixture Pods answered by Oxigraph. No real Pod answered.
