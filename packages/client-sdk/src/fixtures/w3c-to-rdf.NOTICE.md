# W3C JSON-LD test suite notice

[`w3c-to-rdf.json`](w3c-to-rdf.json) contains a portion of the W3C JSON-LD
1.1 API test suite. It is test data of this repository and is not part of the
published `@sempods/client-sdk` package.

## Original documents

- Test suite: <https://w3c.github.io/json-ld-api/tests/>
- Source: <https://github.com/w3c/json-ld-api/tree/fd4f7eb41f679fb73a54923143c473c3a1d06093/tests>,
  manifest `tests/toRdf-manifest.jsonld` and the input and expected-output
  files it names under `tests/toRdf/`.
- The suite accompanies the W3C Recommendation
  [JSON-LD 1.1 Processing Algorithms and API](https://www.w3.org/TR/json-ld11-api/).
  The test suite states no separate status.

## Copyright

Copyright © 2026 World Wide Web Consortium (MIT, ERCIM, Keio, Beihang) and
others. All Rights Reserved. <https://www.w3.org/copyright/test-suites-licenses/>

The year is that of the copied revision (2026-11-18); the tests carry no
copyright notice of their own.

## Licenses

The upstream test suite is "Distributed under the W3C Test Suite License"
([2008 version](https://www.w3.org/copyright/test-suite-license-2008/), as
linked from the suite's
[README](https://github.com/w3c/json-ld-api/blob/fd4f7eb41f679fb73a54923143c473c3a1d06093/tests/README.md#distribution);
superseded by the
[2023 version](https://www.w3.org/copyright/test-suite-license-2023/)), and
the repository's
[LICENSE.md](https://github.com/w3c/json-ld-api/blob/fd4f7eb41f679fb73a54923143c473c3a1d06093/LICENSE.md)
licenses its documents under the
[W3C Software and Document License](https://www.w3.org/copyright/software-license/).
The licence texts are not reproduced here; follow the links above.

The upstream disclaimer applies to the copied tests:

> UNDER THE EXCLUSIVE LICENSE, THIS DOCUMENT AND ALL DOCUMENTS, TESTS AND
> SOFTWARE THAT LINK THIS STATEMENT ARE PROVIDED "AS IS," AND COPYRIGHT
> HOLDERS MAKE NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR IMPLIED,
> INCLUDING, BUT NOT LIMITED TO, WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
> PARTICULAR PURPOSE, NON-INFRINGEMENT, OR TITLE; THAT THE CONTENTS OF THE
> DOCUMENT ARE SUITABLE FOR ANY PURPOSE; NOR THAT THE IMPLEMENTATION OF SUCH
> CONTENTS WILL NOT INFRINGE ANY THIRD PARTY PATENTS, COPYRIGHTS, TRADEMARKS
> OR OTHER RIGHTS. COPYRIGHT HOLDERS WILL NOT BE LIABLE FOR ANY DIRECT,
> INDIRECT, SPECIAL OR CONSEQUENTIAL DAMAGES ARISING OUT OF ANY USE OF THE
> DOCUMENT OR THE PERFORMANCE OR IMPLEMENTATION OF THE CONTENTS THEREOF.

## What was copied, unchanged

The tests themselves are not changed. Each selected case keeps its manifest
`@id`, `name`, error code and base, its input file's text as a string and
its expected N-Quads file's text, byte for byte. Only the selection (62 of
468 cases) and the surrounding JSON are this repository's.
[`scripts/vendor-w3c-to-rdf.mjs`](../../../../scripts/vendor-w3c-to-rdf.mjs)
regenerates the file from a checkout; the selection and the cases that are
not run are explained in [PROVENANCE](../../PROVENANCE.md).
