# Local retrieval baseline

Recorded on 2026-08-30 with `semantic-contract-v1`,
`section-aware-lexical-v1`, and the 25-case local product evaluation package.

| Measurement | Result |
| --- | ---: |
| Reviewed cases | 25 |
| Expected affected targets | 28 |
| Expected targets retrieved | 28 |
| Retrieval recall | 100% |
| Expected targets in the top three | 28 |
| Top-three recall | 100% |
| Positive cases with every expected target retrieved | 100% |
| Average candidates per case | 3.28 |
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

Documentation-first retrieval excludes tests as separate review targets. Tests
remain indexed relationship context, and the product reminds reviewers to
check related tests when a primary implementation file is suggested.

The regression test prevents this baseline from silently getting worse. A live
semantic analyzer must still be evaluated on final decisions before SpecGraph
claims the M9 precision, recall, F1, false-positive-rate, evidence, cost, or
latency targets.

## Live semantic baseline

Recorded on 2026-08-30 with `google/gemini-2.5-flash-lite`,
`review-triage-v3`, the 25-case package above, and no provider fallbacks.

| Measurement | Result |
| --- | ---: |
| Reviewed cases | 25 |
| Expected affected targets | 28 |
| True positives | 17 |
| False positives | 1 |
| False negatives | 11 |
| Precision | 94.4% |
| Recall | 60.7% |
| F1 | 73.9% |
| False-positive rate | 0.41% |
| Total model latency | 39.7 seconds |
| Input tokens | 37,233 |
| Output tokens | 7,801 |

The calibration treats tests as supporting context for documentation-first
review and asks the model to select the narrowest production owner. This
removed the two test-file false positives while improving recall. The one
remaining false positive is `request-limits.ts`, which enforces workspace
authorization but is secondary to the benchmark's primary owner,
`workspace-auth.ts`. Production semantic findings remain disabled: this is a
useful experimental baseline, not yet the selected production threshold.

### Decision-trace diagnostic run

A second live run on 2026-08-30 used the same model, calibration, fixtures, and
threshold with evaluation-only candidate tracing enabled. The trace records
IDs, scores, and dispositions, but never source text, excerpts, prompts, model
summaries, or URLs.

| Measurement | Result |
| --- | ---: |
| True positives | 17 |
| False positives | 2 |
| False negatives | 11 |
| Precision | 89.5% |
| Recall | 60.7% |
| F1 | 72.3% |
| False-positive rate | 0.82% |
| Total model latency | 35.8 seconds |
| Input tokens | 37,233 |
| Output tokens | 7,836 |
| Provider fallbacks | 0 |

The 11 misses now have actionable causes:

- 9 were explicit model-negative decisions;
- 1 was model-positive with exact evidence, but its combined confidence was
  `0.7672`, below the `0.78` display threshold;
- 1 was model-positive at `0.85`, but its returned excerpt was not byte-exact
  and was correctly rejected.

Candidate retrieval was not the cause: every expected target still reached the
bounded candidate set. The difference between the two live runs also shows
that one pass is not a stability claim. Prompt or threshold tuning should wait
for repeated-run measurements and should target model classification and exact
evidence selection rather than broadening retrieval.
