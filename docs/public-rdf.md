# Look up public RDF on the web

Use this guide when a person asks to see what the web says about a resource
that no Pod describes, for example a DBpedia or schema.org IRI that a Pod value
points to. The app fetches the IRI's own document once, without any Pod
credential, and shows its statements as a separate public source.

The SDK does not do this itself. A Pod handle sends requests only to the
endpoints the SDK builds for its Pod and never fetches a resource IRI at its own
origin. The recipe uses a plain `fetch` and two parsers the app installs, so no
SDK import brings a parser along. Copy and adapt it:

- [`public-rdf.ts`](../examples/todo/recipes/public-rdf.ts) has
  `lookupPublicRdf(iri, options)` and `publicAddress(iri)`. It has no React
  dependency.
- It imports [`n3`](https://www.npmjs.com/package/n3) and
  [`jsonld`](https://www.npmjs.com/package/jsonld) lazily, on the first lookup
  that needs them. Add both to the app, and `@types/n3` and `@types/jsonld` for
  TypeScript. They bundle for the browser without Node polyfills.

The statements use the SDK's `SparqlTerm`, so the
[RDF value recipe](rdf-values.md) shows them like the values of a SPARQL read.

## The small path

Look up an IRI only when the person asks for it, and cancel the lookup when
they move on. In this fragment, `show`, `showFailure` and `bundledContexts` are
the app's own:

```ts
const lookup = new AbortController();

const result = await lookupPublicRdf(iri, {
  signal: lookup.signal,
  contexts: bundledContexts,
});

switch (result.kind) {
  case 'loaded':
    show({ source: result.source, statements: result.statements });
    break;
  case 'failed':
    showFailure(result.reason);
    break;
  case 'cancelled':
    break;
}
```

`publicAddress(iri)` applies the same address checks without a request. Use it
to decide whether to offer the lookup at all.

## When to offer a lookup

What a Pod says about an IRI decides how the app reads it, not the IRI's host or
path:

- **The Pod describes it.** A current authorized read names the IRI as a
  subject: a Context description or the catalogue, `get`, a SPARQL or search
  result. Then the IRI is Pod data, and the app reads more of it through the
  Pod handle, whatever host or path it has. A Pod may describe subjects under
  API URLs outside its own path, or on another host. Without a session, read a
  Pod's public Contexts through the runtime's
  [`signIn` option](browser-runtime.md#apps-without-sign-in), not through this
  lookup.
- **Only a value points to it.** An IRI that appears only as an object
  activates nothing. The app may offer a public lookup, and runs it only on the
  person's explicit action.
- **A matching URL proves nothing.** An IRI under the Pod's URL is not
  necessarily Pod data, and one on another host does not need a public lookup.
  Never send a Pod credential because of an IRI's host. The SDK sends the Pod's
  token only to the endpoints it builds for that Pod.

## Keep sources apart

- **Exact identity.** An IRI is compared as received: `http://` and `https://`,
  a trailing slash and letter case make different IRIs. The lookup normalises
  nothing.
- **Separate source.** The statements belong to `result.source`, the document
  URL (the IRI without its fragment). Keep them under that source. Do not write
  them to a Pod or merge them into the results of a Pod read.
- **Withdrawal.** When a Pod source goes away (access lost, a Context
  deselected, the session ended), remove what it described. A public source
  loaded before stays as it is, and it does not take the place of the withdrawn
  Pod data. Removing a public source leaves the Pod data alone.
- **Blank nodes.** A blank node label is local to one lookup. In an HTML page,
  all JSON-LD scripts form one dataset, as JSON-LD 1.1 requires: `_:x` in two
  scripts of the page names one node.

## What the lookup sends and accepts

- **No credentials.** The request uses `credentials: 'omit'`,
  `referrerPolicy: 'no-referrer'` and sets only an `Accept` header. It sends no
  cookie, `Authorization` header, Pod token or referrer. The browser still sends
  the app's `Origin`, and the other site learns the IRI that was looked up. The
  `fetch` option is for tests; never pass a Pod transport there.
- **Public addresses only.** The IRI must be `https:` without user name or
  password. It may not name `localhost` or a `.localhost`, `.localdomain`,
  `.local`, `.internal` or `.home.arpa` host, or a single-label host such as
  `intranet`. Address literals are refused when they are unspecified, loopback,
  private, shared (`100.64.0.0/10`), link-local, multicast or another special
  IPv4 range (`192.0.0.0/24`, `198.18.0.0/15`, `240.0.0.0/4`), or unique local
  or site-local IPv6. An IPv6 literal that embeds an IPv4 address
  (IPv4-compatible, IPv4-mapped, IPv4-translated, NAT64 or 6to4) counts as
  that address; local-use NAT64 is refused. The numeric forms `URL`
  normalises, such as `https://2130706433/`, are caught as `127.0.0.1`.
- **No redirects.** A redirect fails with `redirect-blocked` before the target
  is requested. When a site redirects, as many Linked Data servers do with
  `303 See Other`, the person can look up the target IRI explicitly.
- **Time and size.** One deadline (`timeoutMs`, 10 s by default) covers the
  headers and the body. The body is read as a stream and cancelled once it
  passes `maxBytes` (2 MiB by default), whatever `Content-Length` says.
- **No preflight.** The `Accept` value stays under 128 bytes, so it remains a
  CORS-safelisted header.
- **No remote contexts.** JSON-LD never loads a remote context. The `contexts`
  option maps exact context URLs to copies the app bundles; every other
  context URL fails the lookup with `remote-context`. Many pages use
  `"@context": "https://schema.org"`; bundle that context to read them.

## Formats

The response's `Content-Type` alone chooses the parser:

| Media type                                | Parser                             |
| ----------------------------------------- | ---------------------------------- |
| `text/turtle`, `application/n-triples`    | `n3`                               |
| `application/n-quads`, `application/trig` | `n3`                               |
| `application/ld+json`                     | `jsonld`                           |
| `text/html`, `application/xhtml+xml`      | every `application/ld+json` script |

The body is read as UTF-8, which the RDF formats require; a `charset`
parameter is ignored. Graph names are dropped: statements of named graphs,
including JSON-LD named graphs, join the others, and a triple in several graphs
is kept once. A JSON-LD body must be an object or an array; a bare string would
otherwise be loaded as a document URL.

HTML is parsed with `DOMParser`, which builds an inert document: no script
runs and nothing loads. `application/xhtml+xml` is parsed as XML, so CDATA
sections and character references read as XML defines them, and malformed XML
fails with `parse-failed`. Relative IRIs in the scripts resolve against the
page's first `<base href>`, or else against the document URL. Other media types, including `application/json`,
RDF/XML and RDFa, fail with `unsupported-type`.

## Results and failures

A loaded result has `source`, `contentType` and `statements`. Each statement has
a `subject`, `predicate` and `object` as `SparqlTerm`:

- A language-tagged literal has its `language` and no datatype.
- A literal of `xsd:string` has no datatype; any other datatype is kept, with
  its lexical form unchanged. A JSON number in JSON-LD has no lexical form and
  gets the canonical one (`1.5` becomes `"1.5E0"^^xsd:double`); a string such
  as `"01.00"` with `xsd:double` stays as written.
- A literal with a base direction (Turtle's `"…"@ar--rtl`, or JSON-LD's
  `@direction` with `@language`) and an RDF 1.2 triple term are `unsupported`
  terms. They keep the term in SPARQL 1.2 JSON form (`its:dir`, or
  `type: 'triple'`), so it is not flattened into another term. A `@direction`
  without `@language` keeps the datatype jsonld gives it, such as
  `https://www.w3.org/ns/i18n#_rtl`.

A failed result names its `reason`:

| Reason                                              | Meaning                                                     |
| --------------------------------------------------- | ----------------------------------------------------------- |
| `invalid-iri`, `unsupported-scheme`, `blocked-host` | The address was refused; nothing was requested.             |
| `redirect-blocked`                                  | The origin redirected; the target was not requested.        |
| `network`                                           | No answer, or the origin does not allow cross-origin reads. |
| `timeout`                                           | The deadline passed before the body was complete.           |
| `http-error`                                        | An answer other than `200`; `status` holds it.              |
| `too-large`                                         | The body passed `maxBytes`.                                 |
| `unsupported-type`                                  | The media type has no parser here.                          |
| `remote-context`                                    | The JSON-LD needs a context the app did not bundle.         |
| `parse-failed`                                      | The body is not valid in its media type.                    |

A browser reports a missing CORS permission like an unreachable host, so both
are `network`. `cancelled` means the caller's `signal` aborted.

## Limits

- Only origins that allow cross-origin reads can be looked up from a browser.
  The recipe uses no proxy.
- Hostnames are not resolved. A public name that resolves to a private address
  (DNS rebinding) is not caught.
- Parsing runs on the main thread after the body is complete. The byte cap
  bounds its work; the deadline does not interrupt it.
- Focusing a large graph, following references and limiting statements belong
  to the app. The recipe looks up exactly one document per call and caches
  nothing.
- HTML in another encoding than UTF-8 shows garbled text.
- The SDK's tests run the recipe with both parsers against fixture answers and
  `DOMParser` in jsdom. The packed consumer gates type-check it against the
  installed parsers. That it bundles without Node polyfills and that
  `DOMParser` runs no script were checked once in Chromium, not by a gate. A
  real browser's CORS and redirect handling and live origins are not covered.
