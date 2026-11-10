# Review tests with a change

Start from the actual diff or requested paths and the applicable AGENTS.md scopes.
Each behavior has one owning test, beside the code that decides it. Other layers
test only what they decide themselves. Adding a test is cheap; a suite that only
grows hides which test guards what, so a change that moves a decision also moves
or removes the tests of the old place.

1. Find where decisions moved: a new shared helper, a caller that now delegates,
   a removed rule or name. Search tests beyond the changed files for the old
   rule's cases: its value lists, literals, error texts and issue references.
2. Give each behavior a home. Its matrix of edge cases lives in the defining
   module's tests. A caller keeps one representative case per rule it delegates,
   proving that it delegates, plus the cases of its own decisions (its range,
   outcome, rendering or recovery).
3. Classify each finding:
   - _duplicate_: the same input and expectation at another layer, without a
     decision of that layer;
   - _stale_: it tests removed behavior or an old name, or describes a rule now
     owned elsewhere, in its title, comment or issue reference;
   - _weak_: it still passes with the guard removed (only a happy path,
     `toBeDefined`, a broad snapshot);
   - _missing_: changed behavior without a regression that fails on the old code.
4. Keep tests that prove a different boundary, even with the same inputs: packed
   consumers, the browser gate, engine or ICU differences, specification and
   interoperability cases. Keep an issue's regression unless its exact case lives
   in the owning test.
5. Prove each removal. Name the remaining test that checks the same input and
   relevant expectation at the same boundary, or show by mutation that a
   remaining test catches the same fault (change the guard, run the test, restore
   it). A shared input alone is not evidence: classifying a value does not prove
   that a caller preserves it when writing or renders its fallback. Retain those
   caller assertions. When a change must show that existing output
   stays unchanged, run the old tests on that commit first and consolidate in a
   later commit.
6. Consolidate rather than copy: `it.each` tables, shared fixtures and builders.
   Remove dead helpers and skipped tests without an open issue. Do not weaken an
   assertion to make tests shorter.
7. Run the affected commands from [development](../development.md), at least
   `pnpm test` and the gates of the touched layers. Record in the PR the removed
   or merged cases with where they are covered now, the test line delta, the
   checks and the remaining findings. For a review request, report findings; edit
   only when fixing is in scope.

A coverage figure cannot tell a duplicate from a boundary test; decide from what
each layer decides. A new agent session should be able to repeat the review from
the diff and this procedure, without conversation history.
