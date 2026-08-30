import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnalysisArtifactKind } from "../lib/analysis/candidates";
import {
  generateSemanticCandidates,
  SEMANTIC_RETRIEVAL_VERSION,
  type SemanticArtifactSnapshot,
} from "../lib/analysis/semantic";
import {
  calculateEvaluationMetrics,
  type EvaluationMetrics,
} from "../lib/analysis/evaluation";

export type EvaluationTag =
  | "code-first"
  | "documentation-first"
  | "openapi"
  | "test"
  | "unrelated"
  | "ambiguous";

export type EvaluationDirection =
  | "repository-to-documentation"
  | "documentation-to-repository"
  | "documentation-to-documentation";

export type EvaluationFixtureScope = "confluence" | "repository";

export type ProductEvaluationCaseDefinition = {
  id: string;
  title: string;
  tags: EvaluationTag[];
  direction: EvaluationDirection;
  changedFixture: string;
  changedText?: string;
  candidateScope: EvaluationFixtureScope;
  expectedAffected: string[];
  rationale: string;
};

export type LoadedProductEvaluationCase = ProductEvaluationCaseDefinition & {
  changed: SemanticArtifactSnapshot;
  candidates: SemanticArtifactSnapshot[];
};

export type RetrievalCaseResult = {
  id: string;
  expected: string[];
  retrieved: string[];
  expectedHits: string[];
  topThreeHits: string[];
};

export type RetrievalEvaluationReport = {
  retrievalVersion: string;
  caseCount: number;
  expectedTargetCount: number;
  retrievedExpectedTargetCount: number;
  topThreeExpectedTargetCount: number;
  retrievalRecall: number;
  topThreeRecall: number;
  caseCoverage: number;
  unrelatedCasesWithCandidates: number;
  averageCandidateCount: number;
  cases: RetrievalCaseResult[];
};

const evaluationDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = join(evaluationDirectory, "fixtures");

function fixtureText(relativePath: string): string {
  return readFileSync(join(fixtureDirectory, relativePath), "utf8");
}

function artifactKind(relativePath: string): AnalysisArtifactKind {
  if (relativePath.startsWith("confluence/")) return "confluence";
  if (relativePath.endsWith(".test.ts")) return "test";
  if ([".yaml", ".yml"].includes(extname(relativePath))) return "openapi";
  if ([".md", ".mdx"].includes(extname(relativePath))) return "markdown";
  return "code";
}

function artifact(relativePath: string, textOverride?: string): SemanticArtifactSnapshot {
  return {
    nodeId: relativePath,
    artifactId: relativePath,
    kind: artifactKind(relativePath),
    path: relativePath,
    revision: "local-evaluation-v1",
    sourceUrl: null,
    text: textOverride ?? fixtureText(relativePath),
  };
}

export const productEvaluationCases: ProductEvaluationCaseDefinition[] = [
  {
    id: "code-daily-cadence",
    title: "Daily automatic analysis cadence changes",
    tags: ["code-first"],
    direction: "repository-to-documentation",
    changedFixture: "repository/analysis-cadence.ts",
    candidateScope: "confluence",
    expectedAffected: ["confluence/how-specgraph-works.md"],
    rationale: "The product overview explains that automatic analysis runs daily.",
  },
  {
    id: "code-manual-analysis",
    title: "Immediate manual analysis behavior changes",
    tags: ["code-first"],
    direction: "repository-to-documentation",
    changedFixture: "repository/manual-analysis.ts",
    candidateScope: "confluence",
    expectedAffected: ["confluence/how-specgraph-works.md"],
    rationale: "The product overview describes the immediate check and its progress experience.",
  },
  {
    id: "code-equal-source-groups",
    title: "Provider-neutral source group membership changes",
    tags: ["code-first"],
    direction: "repository-to-documentation",
    changedFixture: "repository/source-groups.ts",
    candidateScope: "confluence",
    expectedAffected: ["confluence/how-specgraph-works.md"],
    rationale: "The overview states that every connected source is an equal group member.",
  },
  {
    id: "code-source-dialog",
    title: "Add-source dialog behavior changes",
    tags: ["code-first"],
    direction: "repository-to-documentation",
    changedFixture: "repository/source-connections.ts",
    candidateScope: "confluence",
    expectedAffected: ["confluence/how-specgraph-works.md"],
    rationale: "The overview explains how teams connect more sources to a group.",
  },
  {
    id: "code-review-decisions",
    title: "Persisted review decisions change",
    tags: ["code-first"],
    direction: "repository-to-documentation",
    changedFixture: "repository/review-actions.ts",
    candidateScope: "confluence",
    expectedAffected: ["confluence/how-specgraph-works.md"],
    rationale: "Resolve, dismiss, reopen, and persistence are user-visible product behavior.",
  },
  {
    id: "code-retry-policy",
    title: "Automatic retry limits change",
    tags: ["code-first", "ambiguous"],
    direction: "repository-to-documentation",
    changedFixture: "repository/run-retries.ts",
    candidateScope: "confluence",
    expectedAffected: [
      "confluence/how-specgraph-works.md",
      "confluence/operations-runbook.md",
    ],
    rationale: "The retry policy is described both to users and to operators.",
  },
  {
    id: "code-evidence-verification",
    title: "Evidence verification rules change",
    tags: ["code-first"],
    direction: "repository-to-documentation",
    changedFixture: "repository/evidence-verification.ts",
    candidateScope: "confluence",
    expectedAffected: ["confluence/how-specgraph-works.md"],
    rationale: "The overview promises exact supporting excerpts and rejection of unsupported evidence.",
  },
  {
    id: "code-github-ingestion",
    title: "GitHub delivery deduplication changes",
    tags: ["code-first", "ambiguous"],
    direction: "repository-to-documentation",
    changedFixture: "repository/github-ingestion.ts",
    candidateScope: "confluence",
    expectedAffected: [
      "confluence/how-specgraph-works.md",
      "confluence/security-and-access.md",
    ],
    rationale: "Automatic analysis and duplicate event safety span product and security guidance.",
  },
  {
    id: "code-confluence-refresh",
    title: "Confluence incremental refresh changes",
    tags: ["code-first"],
    direction: "repository-to-documentation",
    changedFixture: "repository/confluence-sync.ts",
    candidateScope: "confluence",
    expectedAffected: ["confluence/how-specgraph-works.md"],
    rationale: "The overview explains source refresh and daily analysis.",
  },
  {
    id: "code-workspace-authorization",
    title: "Workspace authorization changes",
    tags: ["code-first"],
    direction: "repository-to-documentation",
    changedFixture: "repository/workspace-auth.ts",
    candidateScope: "confluence",
    expectedAffected: ["confluence/security-and-access.md"],
    rationale: "Workspace isolation is the central promise of the security page.",
  },
  {
    id: "code-source-retention",
    title: "Source disconnection retention changes",
    tags: ["code-first"],
    direction: "repository-to-documentation",
    changedFixture: "repository/source-retention.ts",
    candidateScope: "confluence",
    expectedAffected: ["confluence/data-retention.md"],
    rationale: "The retention page defines what is removed or preserved on disconnect.",
  },
  {
    id: "code-request-limits",
    title: "Authorization and request limits change",
    tags: ["code-first", "ambiguous"],
    direction: "repository-to-documentation",
    changedFixture: "repository/request-limits.ts",
    candidateScope: "confluence",
    expectedAffected: [
      "confluence/security-and-access.md",
      "confluence/operations-runbook.md",
    ],
    rationale: "Bounded authorized requests affect both security and operations guidance.",
  },
  {
    id: "doc-source-groups",
    title: "Source-group product description changes",
    tags: ["documentation-first"],
    direction: "documentation-to-repository",
    changedFixture: "confluence/how-specgraph-works.md",
    changedText: "Connected source groups contain repositories and documentation spaces as equal members. Teams can start with documentation or a repository and connect more sources later.",
    candidateScope: "repository",
    expectedAffected: ["repository/source-groups.ts"],
    rationale: "The source-group implementation must still satisfy the revised product contract.",
  },
  {
    id: "doc-manual-analysis",
    title: "Manual check product description changes",
    tags: ["documentation-first"],
    direction: "documentation-to-repository",
    changedFixture: "confluence/how-specgraph-works.md",
    changedText: "A person can start an immediate manual analysis and sees progress in a centered dialog until the check completes.",
    candidateScope: "repository",
    expectedAffected: ["repository/manual-analysis.ts"],
    rationale: "Manual analysis execution and progress presentation implement this behavior.",
  },
  {
    id: "doc-daily-analysis",
    title: "Daily cadence description changes",
    tags: ["documentation-first", "ambiguous"],
    direction: "documentation-to-repository",
    changedFixture: "confluence/how-specgraph-works.md",
    changedText: "Automatic analysis refreshes connected sources on a daily cadence and incrementally checks newly captured changes.",
    candidateScope: "repository",
    expectedAffected: [
      "repository/analysis-cadence.ts",
      "repository/confluence-sync.ts",
    ],
    rationale: "Both scheduling and source refresh implement the stated cadence.",
  },
  {
    id: "doc-review-lifecycle",
    title: "Suggestion review lifecycle changes",
    tags: ["documentation-first"],
    direction: "documentation-to-repository",
    changedFixture: "confluence/how-specgraph-works.md",
    changedText: "Reviewers resolve, dismiss, or reopen individual suggestions. Decisions persist across reloads and repeated analysis of the same impact.",
    candidateScope: "repository",
    expectedAffected: ["repository/review-actions.ts"],
    rationale: "The review-action implementation owns the documented lifecycle.",
  },
  {
    id: "doc-failure-recovery",
    title: "Failure recovery description changes",
    tags: ["documentation-first"],
    direction: "documentation-to-repository",
    changedFixture: "confluence/how-specgraph-works.md",
    changedText: "Automatic analysis retries temporary failures only three times, then records a permanent failed state with a safe retry action.",
    candidateScope: "repository",
    expectedAffected: ["repository/run-retries.ts"],
    rationale: "The retry implementation must match the public failure-recovery promise.",
  },
  {
    id: "doc-evidence-contract",
    title: "Evidence and confidence description changes",
    tags: ["documentation-first"],
    direction: "documentation-to-repository",
    changedFixture: "confluence/how-specgraph-works.md",
    changedText: "Every suggestion shows an exact supporting excerpt. Unsupported evidence and confidence are rejected instead of displayed.",
    candidateScope: "repository",
    expectedAffected: ["repository/evidence-verification.ts"],
    rationale: "Evidence verification enforces this user-facing contract.",
  },
  {
    id: "doc-provider-connection",
    title: "Repository connection behavior changes",
    tags: ["documentation-first", "ambiguous"],
    direction: "documentation-to-repository",
    changedFixture: "confluence/how-specgraph-works.md",
    changedText: "A source group can connect GitHub repositories through the Add source provider dialog. Repository changes trigger automatic analysis without duplicate work.",
    candidateScope: "repository",
    expectedAffected: [
      "repository/source-connections.ts",
      "repository/github-ingestion.ts",
    ],
    rationale: "Provider setup and event ingestion jointly implement the documented flow.",
  },
  {
    id: "doc-workspace-isolation",
    title: "Workspace isolation policy changes",
    tags: ["documentation-first"],
    direction: "documentation-to-repository",
    changedFixture: "confluence/security-and-access.md",
    changedText: "Every repository, documentation source, run, finding, and review action must be authorized through the signed-in person's isolated workspace.",
    candidateScope: "repository",
    expectedAffected: ["repository/workspace-auth.ts"],
    rationale: "The workspace authorization helper enforces the revised policy.",
  },
  {
    id: "openapi-operation-rename",
    title: "Analysis operation is renamed",
    tags: ["code-first", "openapi"],
    direction: "repository-to-documentation",
    changedFixture: "repository/openapi.yaml",
    changedText: "OpenAPI analysis runs operation startAnalysisRun was renamed to requestAnalysis. Contract documentation covering API paths and operations may need review.",
    candidateScope: "confluence",
    expectedAffected: ["confluence/api-contracts.md"],
    rationale: "The API page explicitly documents matching operation changes.",
  },
  {
    id: "openapi-required-field",
    title: "Analysis request gains a required field",
    tags: ["code-first", "openapi"],
    direction: "repository-to-documentation",
    changedFixture: "repository/openapi.yaml",
    changedText: "OpenAPI request body schema StartAnalysisRun now requires requestedRevision in addition to sourceGroupId. Request examples that omit the required field may be stale.",
    candidateScope: "confluence",
    expectedAffected: ["confluence/api-contracts.md"],
    rationale: "The API page describes required request fields and examples.",
  },
  {
    id: "test-progress-dialog",
    title: "Manual progress-dialog test changes",
    tags: ["code-first", "test"],
    direction: "repository-to-documentation",
    changedFixture: "repository/manual-analysis.test.ts",
    candidateScope: "confluence",
    expectedAffected: ["confluence/how-specgraph-works.md"],
    rationale: "The test protects a user-visible immediate analysis workflow.",
  },
  {
    id: "unrelated-cache-key",
    title: "Internal cache key is renamed",
    tags: ["code-first", "unrelated"],
    direction: "repository-to-documentation",
    changedFixture: "repository/local-cache.ts",
    candidateScope: "confluence",
    expectedAffected: [],
    rationale: "An internal variable rename has no product documentation impact.",
  },
  {
    id: "unrelated-dependency-bump",
    title: "An internal dependency patch version changes",
    tags: ["code-first", "unrelated"],
    direction: "repository-to-documentation",
    changedFixture: "repository/dependency-lock.json",
    candidateScope: "confluence",
    expectedAffected: [],
    rationale: "Routine dependency maintenance without behavior change needs no product update.",
  },
];

function fixturePaths(scope: EvaluationFixtureScope): string[] {
  const paths = scope === "confluence"
    ? [
        "confluence/api-contracts.md",
        "confluence/data-retention.md",
        "confluence/design-system.md",
        "confluence/how-specgraph-works.md",
        "confluence/operations-runbook.md",
        "confluence/security-and-access.md",
        "confluence/team-handbook.md",
      ]
    : [
        "repository/analysis-cadence.ts",
        "repository/confluence-sync.ts",
        "repository/dependency-lock.json",
        "repository/evidence-verification.ts",
        "repository/github-ingestion.ts",
        "repository/local-cache.ts",
        "repository/manual-analysis.test.ts",
        "repository/manual-analysis.ts",
        "repository/openapi-impact.ts",
        "repository/openapi.yaml",
        "repository/request-limits.ts",
        "repository/review-actions.ts",
        "repository/run-retries.ts",
        "repository/source-connections.ts",
        "repository/source-groups.test.ts",
        "repository/source-groups.ts",
        "repository/source-retention.ts",
        "repository/ui-theme.css",
        "repository/workspace-auth.ts",
      ];
  return paths;
}

export function loadLocalEvaluationPackage(): LoadedProductEvaluationCase[] {
  const artifactsByScope = new Map<EvaluationFixtureScope, SemanticArtifactSnapshot[]>([
    ["confluence", fixturePaths("confluence").map((path) => artifact(path))],
    ["repository", fixturePaths("repository").map((path) => artifact(path))],
  ]);
  return productEvaluationCases.map((definition) => ({
    ...definition,
    changed: artifact(definition.changedFixture, definition.changedText),
    candidates: artifactsByScope.get(definition.candidateScope) || [],
  }));
}

export function runSemanticRetrievalBaseline(
  cases: LoadedProductEvaluationCase[] = loadLocalEvaluationPackage(),
): RetrievalEvaluationReport {
  const results = cases.map<RetrievalCaseResult>((evaluationCase) => {
    const retrieved = generateSemanticCandidates(
      evaluationCase.changed,
      evaluationCase.candidates,
    ).map((candidate) => candidate.id);
    const expected = evaluationCase.expectedAffected;
    return {
      id: evaluationCase.id,
      expected,
      retrieved,
      expectedHits: expected.filter((id) => retrieved.includes(id)),
      topThreeHits: expected.filter((id) => retrieved.slice(0, 3).includes(id)),
    };
  });
  const expectedTargetCount = results.reduce((sum, result) => sum + result.expected.length, 0);
  const retrievedExpectedTargetCount = results.reduce(
    (sum, result) => sum + result.expectedHits.length,
    0,
  );
  const topThreeExpectedTargetCount = results.reduce(
    (sum, result) => sum + result.topThreeHits.length,
    0,
  );
  const positiveCases = results.filter((result) => result.expected.length > 0);
  const coveredPositiveCases = positiveCases.filter(
    (result) => result.expectedHits.length === result.expected.length,
  );
  const unrelatedIds = new Set(
    cases.filter((value) => value.tags.includes("unrelated")).map((value) => value.id),
  );
  return {
    retrievalVersion: SEMANTIC_RETRIEVAL_VERSION,
    caseCount: results.length,
    expectedTargetCount,
    retrievedExpectedTargetCount,
    topThreeExpectedTargetCount,
    retrievalRecall: expectedTargetCount
      ? retrievedExpectedTargetCount / expectedTargetCount
      : 1,
    topThreeRecall: expectedTargetCount
      ? topThreeExpectedTargetCount / expectedTargetCount
      : 1,
    caseCoverage: positiveCases.length
      ? coveredPositiveCases.length / positiveCases.length
      : 1,
    unrelatedCasesWithCandidates: results.filter(
      (result) => unrelatedIds.has(result.id) && result.retrieved.length > 0,
    ).length,
    averageCandidateCount:
      results.reduce((sum, result) => sum + result.retrieved.length, 0) /
      Math.max(1, results.length),
    cases: results,
  };
}

export function evaluateFinalPredictions(
  predictions: Record<string, string[]>,
  cases: LoadedProductEvaluationCase[] = loadLocalEvaluationPackage(),
): EvaluationMetrics {
  return calculateEvaluationMetrics(
    cases.map((evaluationCase) => ({
      expected: evaluationCase.expectedAffected,
      predicted: predictions[evaluationCase.id] || [],
      candidateUniverse: evaluationCase.candidates.map((candidate) => candidate.nodeId),
    })),
  );
}
