# Local SpecGraph evaluation package

This folder is a repeatable, network-free product-quality lab. The
`fixtures/confluence` directory simulates a small Confluence space using normal
product language rather than explicit code links. The `fixtures/repository`
directory contains the code, tests, and OpenAPI snapshots that implement the
same behavior.

The package defines exactly 25 reviewed changes covering code-first,
documentation-first, OpenAPI, test, unrelated, and ambiguous scenarios. Every
case records which artifacts a reviewer expects SpecGraph to flag and why.

Run it with:

```bash
npm run test:evaluation
```

## What the first baseline measures

The local baseline measures **candidate retrieval**: whether the expected page
or file reaches the bounded set that a semantic analyzer would be allowed to
review. It reports retrieval recall, top-three recall, case coverage, and
candidate-set size.

Candidate retrieval is deliberately broader than a displayed finding. It is
not final model precision. `evaluateFinalPredictions` accepts final analyzer
decisions for the same 25 cases and calculates precision, recall, F1, and the
false-positive rate. This makes future deterministic and AI-assisted results
directly comparable without changing the test corpus.

## Adding or changing a case

1. Add or edit a realistic fixture. Keep Confluence pages understandable to a
   nontechnical reader and avoid adding code paths solely to make matching easy.
2. Add the case and its reviewed expected targets in
   `specgraph-product-cases.ts`.
3. Run the evaluation command and inspect any missed target before changing a
   threshold or fixture.
4. Treat label changes as product decisions: record why an artifact should or
   should not be flagged.

No fixture touches the live Confluence connector, OAuth credentials, or the
production database.
