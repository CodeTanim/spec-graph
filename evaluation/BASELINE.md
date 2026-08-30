# Local retrieval baseline

Recorded on 2026-08-30 with `semantic-contract-v1`,
`section-aware-lexical-v1`, and the 25-case local product evaluation package.

| Measurement | Result |
| --- | ---: |
| Reviewed cases | 25 |
| Expected affected targets | 28 |
| Expected targets retrieved | 28 |
| Retrieval recall | 100% |
| Expected targets in the top three | 27 |
| Top-three recall | 96.4% |
| Positive cases with every expected target retrieved | 100% |
| Average candidates per case | 3.64 |
| Unrelated cases that produced candidates | 1 of 2 |

This is a **candidate-retrieval baseline**, not final finding precision. The
fixtures intentionally use natural product documentation without planting code
paths in the prose. Section-aware matching and code-word normalization retrieve
every reviewed target while keeping the average candidate set below four.

One routine dependency update retrieves the API-contract page because both
contain a small amount of generic contract/version language. That page is only
a candidate for review; a final analyzer should reject it rather than display a
finding. This tradeoff is recorded so later model evaluation can measure the
actual decision instead of pretending candidate retrieval is final precision.

The regression test prevents this baseline from silently getting worse. A live semantic analyzer must
still be evaluated on final decisions before SpecGraph claims the M9 precision,
recall, F1, false-positive-rate, evidence, cost, or latency targets.
