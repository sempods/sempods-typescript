# Show resource cards with pictures

Use this guide when an app shows resources from the person's Pods as cards,
such as the nodes of a graph explorer or search suggestions. Each card can show
a picture, a label and a date. Every value keeps the Pod and Context it was
read from, and the picture loads as an ordinary image.

The recipe uses only public exports:

- `usePodLoad` with one connection's `BoundPod`,
- `podReadLimit` and `priority: 'current'` on the runtime,
- the terms of a SELECT,
- the [RDF value recipe](rdf-values.md) for readable dates.

It has no renderer registry. The types, paths and limits are the app's own.
Copy and adapt it:

- [`resource-cards.ts`](../examples/todo/recipes/resource-cards.ts) has the
  rules, the query, the facts of one read and their merge into cards. It
  includes the image address check. It has no React dependency.
- [`resource-card-view.tsx`](../examples/todo/recipes/resource-card-view.tsx)
  reads per connection (`useResourceCards`). It contains a bounded
  `ImagePreview`, a compact `ResourceCardView` and `CardEvidence`, which shows
  where each value comes from.

## The small path

Set `podReadLimit` on the runtime, for example `{ perPod: 4, total: 8 }`
([bounded Pod reads](browser-runtime.md#bounded-pod-reads)). A list of cards
starts one read per resource and Pod; without a limit, all of them start at
once.

Then admit and bound the resources the app shows, and render their cards.
`CardList` in the recipe is the whole path:

```tsx
export function CardList({
  runtime,
  roots,
}: {
  readonly runtime: BrowserRuntime;
  readonly roots: readonly string[];
}) {
  const { cards, status, readers } = useResourceCards(runtime, roots);
  const { language } = useSdkLocale();
  const shown = [...new Set(roots.flatMap((root) => cards.get(root) ?? []))];
  return (
    <>
      {readers}
      <ul>
        {shown.map((card) => (
          <li key={card.root}>
            <ResourceCardView
              card={card}
              status={status(card)}
              label={labelFor(card.root, commonVocabulary, language)}
            />
          </li>
        ))}
      </ul>
    </>
  );
}
```

`readers` renders nothing. It mounts one `usePodLoad` per resource and reading
connection, so render it once. Resources joined by `sameAs` share one card, so
the list shows each card once. Replace the list and the label with the app's
own layout and names.

`<CardDetails runtime={runtime} root={selected} />` shows one selected
resource with all its evidence. Its reads use `priority: 'current'`: while the
list's reads still wait for a slot, the selected resource is read first. This
reads the resource once more, at most once per reading connection.

## Declared paths

A rule names the types it presents, then its image paths and date predicates,
each in order of preference. The recipe's example:

```ts
export const exampleRules: readonly CardRule[] = [
  {
    id: 'person',
    types: [...schema('Person'), `${FOAF}Person`],
    images: pictures,
    dates: [],
  },
  {
    id: 'event',
    types: schema('Event'),
    images: pictures,
    dates: schema('startDate'),
  },
  {
    id: 'image',
    types: schema('ImageObject'),
    images: [[imageVariants]],
    dates: [],
    isImage: true,
  },
  { id: 'resource', types: [], images: pictures, dates: [] },
];
```

An empty `types` list matches any resource, so that rule comes last. `isImage`
says that the resource is itself one picture, as an `ImageObject` is: its
direct values are variants of that picture. Without it, each direct value is a
picture of its own. Only the card's rule decides this, never another rule.

A path has one or two steps, and each step lists alternative predicates:

- `[[schema:image]]` takes the resource's own value as the address.
- `[[schema:image], [schema:thumbnailUrl, schema:contentUrl]]` takes the
  addresses of the node the resource links to, such as an `ImageObject`.

The card's rule decides what a linked node is. It is an image description only
where that rule has a path with both its link and its variant predicate. Then
the node's own address is not tried. Otherwise a direct path of the rule still
takes the link's value as the address. The facts of a read keep every match,
so the decision waits until the rule is known.

`schema(name)` lists both schema.org namespaces (`https:` and `http:`), and
`pictures` is the pair of paths above with `schema:image`, `foaf:img` and
`foaf:depiction`. Replace the rules with the app's vocabulary.

`cardQuery(root, rules)` reads exactly what the rules declare, and nothing more:

- the resource's types,
- its alias statements,
- the first step of each path,
- the second step for the nodes it links to, only in the pairs of link and
  variant predicate that a path declares.

`GRAPH ?g` names the Context of each statement. Rows are sorted, and at most 200
are used. The resource's types, aliases and dates come first. Then each image
node follows as one block: its link first, then its variants. A long read is
never cut before the resource's own facts. It can cut a picture partway, but
the kept rows of that picture still include its link, so they still count. For the same data, a
large resource loses the same rows, except where linked nodes are blank: their
labels can change between reads. A read that returns more marks the card as
`truncated`.

The enrichment is metadata only. No value becomes another root, the recipe
reads no linked node beyond its one declared step, and an alias is not
followed. The app decides which resources get cards. Embed only IRIs from
decoded terms; `cardQuery` rejects whitespace and other characters SPARQL
forbids in `<…>`.

## Precedence

Precedence is decided by the rules and the read order, not by which answer
arrives first:

- **Type.** The first rule in the list that matches one of the resource's
  types wins. A resource that is both a person and an event shows as a person,
  whichever Pod said so first.
- **Pictures.** Pictures are ordered by the rule's path order first. Then the
  declared predicate order of the first step decides: `schema:image` before
  `foaf:depiction`. Within a picture, the variants follow the path order, then
  the predicate order of the path's last step: a thumbnail before the
  original. Only after that comes the source: Pods in URL order (adapt it, for example
  to put the active Pod first), then the order of the admitted resources, then
  the read's sorted rows. When a card keeps only four pictures, the preferred
  ones stay.
- **Dates.** A card keeps every distinct date term. The first one in predicate
  and source order shows on the card. With more than one, the card says how
  many others exist, and `CardEvidence` lists each with its exact term and
  sources. `"2026-10-05"^^xsd:date` from two Pods is one date with two sources;
  `"2026-10-06"^^xsd:date` or the string `"2026-10-05"` is another.

## Where each value comes from

Each value is a `Fact` with its `evidence`: one entry per statement that
supports it. An entry holds:

- `pod`: the Pod URL,
- `context`: the Context IRI,
- `subject`: the subject as received,
- `predicate`.

A picture of a linked node has two entries: the link and the address, each in
its own Context. A blank node subject such as `_:b0` is local to one read. The
recipe joins it only within that read and never across reads or Pods.

## `sameAs`

When the facts say that two admitted resources are the same
(`owl:sameAs` by default), they share one card:

- The first admitted one is the card's `root`, and `members` lists both. Both
  resource IRIs map to the same card.
- The statements are not rewritten. A value keeps the subject it was read
  from, and `sameAs` keeps the alias statements with their evidence.
- The cards are recomputed from the current facts every time. When the Pod with
  the alias statement leaves, the two resources are separate cards again.
- An alias to a resource the app did not admit is not followed.

`schema:sameAs` names a web page about the item rather than the same resource.
Add it to the alias predicates only if the app treats it as identity.

## Reads, withdrawal and status

`useResourceCards` mounts one read per admitted resource and reading
connection. Each read is a `usePodLoad` with the connection's `BoundPod` and
its own state:

- **Cancellation.** A resource that is no longer admitted unmounts its reads,
  which cancels a read that is still running.
- **Withdrawal.** When a Pod signs out, disconnects or loses read access, its
  values leave the cards. A connection that no longer reads drops out in the
  same render; a read that loses access reports no data. Nothing is cached
  beyond the current reads: a read that answers again brings the values back.
- **Limits.** Reads beyond `podReadLimit` wait in `loading`. A grant change
  while they wait spends no retry.
- **Rules.** Pass a module-level constant. Another array is compared by
  value, so an inline array does not read again on every render. Changed
  rules give a new query and read again.

`status(card)` tells the app what the reads of the card's members say:

- `unread`: a read has not answered yet. With no reading connection, the
  card is `unread` until startup settles.
- `unavailable`: a read failed, was refused or lost access, or no connection
  reads after startup.

The recipe shows no retry on a card. To read again, the app remounts the
reads. It can also show one source-level notice, for example with `LoadNotice`.

## Image previews

`ImagePreview` shows a picture with an ordinary `<img>`:

- `referrerPolicy="no-referrer"`, `loading="lazy"`, `decoding="async"` and
  `alt=""`. The card's label names the resource.
- No `crossorigin` attribute, and no Pod token. The browser handles cookies,
  redirects, image formats and its cache, as for any image on the web.

Before an address reaches `<img>`, `imageAddress` checks it. It accepts only
`https:` addresses with a host name and without a user name or password. IP
addresses (also IPv4 in hex or octal, which `URL` normalizes) are refused. So
are single-label names and local-looking names such as `localhost`,
`printer.local` or `router.home.arpa`. The card counts the refused values of
its rule's paths in `refused`.

This checks the initial address only. It does not check where a redirect
leads or what a host name resolves to.

The preview is bounded:

- A card keeps at most four pictures with up to three variants each. Variants
  of the same linked node are one picture (a blank node only within its read).
  So are pictures connected by a shared address, also through a chain of them.
  The same address from two Pods or under two predicates counts once, with
  its best rank. The three variants kept are the preferred ones, such as the
  thumbnail. A direct address comes after a node's declared variants. The
  limits apply after merging and ranking.
- A preview tries the addresses in card order. When one fails to load or
  decode, it moves to the next, and it never retries a failed address. Over
  its lifetime it mounts at most six distinct addresses (`MAX_ATTEMPTS`),
  whether they load or fail, also when sources come and go.
- The picture on display stays while its address is still a candidate. A
  candidate that arrives or returns later does not replace it. An address
  that was withdrawn and returns is shown again only after its new element
  loads.

The placeholder keeps its size in every state. Its accessible name says which
state it is in:

| State         | When                                                            |
| ------------- | --------------------------------------------------------------- |
| `shown`       | The picture loaded.                                             |
| `loading`     | An address is being tried.                                      |
| `unread`      | No address yet, and a read has not answered.                    |
| `unavailable` | Every address failed, a read failed, or an address was refused. |
| `absent`      | Every read answered, and no source has a picture.               |

When a source is withdrawn, its addresses are no longer candidates, and the
`<img>` element showing one is removed. This does not erase the browser's
cache.

## Native display versus an authorized byte fetch

An `<img>` is browser-native display. The browser sends the cookies it holds for
the image's host, follows redirects and decodes the format. The app cannot read
the bytes or attach a Pod token. An image server that relies on cookies works
this way. A credentialed `fetch` of the same image may fail on CORS, for
example when the server answers with `Access-Control-Allow-Origin: *`.

A future authorized byte fetch would be a different capability. It would read
the bytes with the person's Pod authorization and could check size, type or
destination. None of that applies to native images. The recipe makes no such
promise, and it needs no SDK media API.

## Limits

- Images have no byte limit, deadline or network concurrency limit from the app.
  The browser schedules them. `MAX_ATTEMPTS` bounds the addresses per preview,
  and the app bounds how many previews it mounts.
- `podReadLimit` bounds Pod reads, not images. RDF documents fetched from the
  web are outside this recipe and need their own safeguards.
- The recipe reads one resource per request. If the number of requests
  matters more than the simplicity, the app can batch several roots in one
  query with `VALUES`. It then needs a stable way to keep batches when the
  admitted resources change.
- A card from a truncated read may miss values; `truncated` says so.
- Evidence comes from the SDK's tests: the SELECT decoder, the generated
  query evaluated by the Oxigraph SPARQL engine, and React in jsdom on two
  fixture Pods. Oxigraph is not a Pod, jsdom loads no image, and no real Pod
  answered. Display
  with cookies, in other browsers and under third-party cookie restrictions
  needs its own validation.
