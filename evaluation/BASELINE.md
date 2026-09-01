# Evaluation baselines

## Current in-sample retrieval calibration

Recorded on 2026-08-30 with `semantic-contract-v1`,
`role-aware-full-file-v2`, and the adjudicated 25-case local product evaluation
package.

| Measurement | Result |
| --- | ---: |
| Reviewed cases | 25 |
| Display-worthy expected targets | 23 |
| Expected targets retrieved | 23 |
| Retrieval recall | 100% |
| Expected targets in the top three | 23 |
| Top-three recall | 100% |
| Positive cases with every expected target retrieved | 100% |
| Average candidates per case | 2.32 |
| Explicitly unrelated cases that produced candidates | 0 of 2 |

This is a **candidate-retrieval baseline**, not final finding precision. The
fixtures use natural product documentation without planting code paths in the
prose. Code-first cases provide the atomic changed scope—the relevant function,
constant, or diff-sized excerpt—instead of treating the whole current file as
changed. Section-aware matching and code-word normalization retrieve every
reviewed target inside the same top-three bound used by the semantic adapter.

The corpus is an **in-sample calibration and regression set**, not an unseen
holdout. Its adjudicated labels, retrieval behavior, and semantic prompt
examples were refined against these same cases. The 100% retrieval and
top-three figures demonstrate fit to the reviewed cases; they are not a claim
of expected recall on unfamiliar repositories or documentation.

Some related but zero-label UI or test scenarios still retrieve candidates.
That is intentional: retrieval favors recall, while the final analyzer rejects
relationships that do not justify a separate human-review suggestion. Neither
case explicitly labeled unrelated produces a candidate.

Documentation-first retrieval excludes tests as separate review targets. Tests
remain indexed relationship context, and the product reminds reviewers to
check related tests when a primary implementation file is suggested.

The current cap of three semantic candidates is provisional. The calibration
set does not yet include a representative change with more than three
legitimate affected targets, so this baseline cannot establish that the cap is
safe for broader use.

Production ingestion now persists private, version-pinned, bounded change
scopes for new and modified GitHub files and Confluence pages. The semantic
adapter can consume a matching scope and fails closed when the scope is missing,
unavailable, or belongs to another artifact. The deployed manual Confluence
path now exposes a deliberately narrow semantic beta when a Gateway model is
configured: exactly one available atomic scope, at most three same-group
candidates, and at most one provider request. Deterministic analysis still runs
first, provider failures fall back without failing the run, and automatic
GitHub/scheduled semantic findings remain disabled. Raw scope snippets are
redacted when a source is removed and after 30 days.

The regression test prevents this baseline from silently getting worse. A live
semantic analyzer must still be evaluated on final decisions before SpecGraph
claims the M9 precision, recall, F1, false-positive-rate, evidence, cost, or
latency targets.

The v2 retriever also has a production-shaped cadence regression. It indexes
only the allowlisted `vercel.json` runtime configuration, scans relevant
passages across long implementation files, excludes evaluation fixtures from
live ingestion, and keeps configuration, production code, and documentation
inside the same three-candidate bound.

## Validation work still required

- Freeze a versioned unseen holdout before using any of its results to change
  prompts, thresholds, retrieval rules, or labels.
- Include at least one realistic holdout case with more than three legitimate
  impacts and use it to validate or revise the candidate cap.
- Run the selected model repeatedly on that holdout and report minimum as well
  as mean quality, critical-case coverage, evidence coverage, latency, token
  usage, and fallbacks.
- Run the unseen holdout through the same persisted change-scope contract used
  by production ingestion before connecting the adapter to live findings.
- Complete deleted-artifact tombstone handling and paginate Confluence spaces
  beyond the current 100-page ingestion limit before claiming complete provider
  change coverage.

No full v6 result is recorded here yet. The v6 adapter extends the calibrated
v5 policy so executable configuration can own a matching runtime behavior.
Its manual-only beta is not an unseen-holdout result and does not establish
production-wide quality.

On 2026-08-30, a one-case v5 Gateway preflight stopped after the first request
returned `Gateway request failed` before any model tokens were reported. The
run was recorded as an analyzer fallback and is not a model-quality result. No
broader live run was attempted, preventing a provider or account failure from
consuming the remaining evaluation requests.

A later diagnostic confirmed that Gateway authentication, credits, and both
configured Google model routes were healthy, making the earlier transport
failure transient. The same one-case preflight then reached the model but
rejected its otherwise valid decision because the provider exceeded the
180-character explanation limit. SpecGraph now deterministically bounds only
that human-facing explanation while retaining strict confidence and exact
evidence verification. The repeated one-case preflight completed with 1 true
positive, 0 false positives, 0 false negatives, no fallback, 2,166 input
tokens, and 145 output tokens. This targeted recovery check is not a full v5
quality baseline and does not satisfy the release gate.

## Historical v3 semantic baseline

Recorded on 2026-08-30 with `google/gemini-2.5-flash-lite`,
`review-triage-v3`, the superseded pre-adjudication 28-target label set, and no
provider fallbacks. These results are retained as diagnostic history and are
not directly comparable with the current 23-target corpus.

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

The v3 calibration treats tests as supporting context for documentation-first
review and asks the model to select the narrowest production owner. This
removed the two test-file false positives while improving recall. The one
remaining false positive is `request-limits.ts`, which enforces workspace
authorization but is secondary to the benchmark's primary owner,
`workspace-auth.ts`. Production semantic findings remain disabled: this is a
useful experimental baseline, not yet the selected production threshold.

### Historical decision-trace diagnostic run

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
