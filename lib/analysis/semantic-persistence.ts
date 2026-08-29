import { and, eq } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import {
  artifactVersions,
  findingEvidence,
  findings,
  relationships,
  semanticAnalysisAttempts,
} from "../../db/schema";
import { sha256Hex } from "../github/crypto";
import { shouldCreateImpactFinding, type CandidateEdge } from "./candidates";
import { createImpactFingerprint } from "./impact-fingerprint";
import {
  buildSemanticAnalysisInput,
  executeSemanticAnalysis,
  generateSemanticCandidates,
  type SemanticAnalyzer,
  type SemanticArtifactSnapshot,
  type SemanticExecution,
} from "./semantic";

type SemanticContext = Map<
  string,
  { graphDistance: number | null; edges: CandidateEdge[] }
>;

export type SemanticPersistenceResult = {
  execution: SemanticExecution;
  persistedFindings: number;
};

function sourceLineUrl(snapshot: SemanticArtifactSnapshot, line: number): string | null {
  if (!snapshot.sourceUrl || snapshot.kind === "confluence") return snapshot.sourceUrl;
  return `${snapshot.sourceUrl.split("#L")[0]}#L${line}-L${line + 3}`;
}

async function recordAttempt(
  runId: string,
  changedNodeId: string,
  execution: SemanticExecution,
  db: SpecGraphDb,
): Promise<void> {
  await db.insert(semanticAnalysisAttempts).values({
    id: `semantic_attempt_${crypto.randomUUID()}`,
    runId,
    changedNodeId,
    analyzerVersion: execution.analyzerVersion,
    analyzerName: execution.analyzerName,
    model: execution.model,
    status: execution.status,
    inputCandidateCount: execution.inputCandidateCount,
    outputDecisionCount: execution.outputDecisionCount,
    acceptedDecisionCount: execution.accepted.length,
    rejectedDecisionCount: execution.rejected.length,
    latencyMs: execution.latencyMs,
    promptTokens: execution.usage.promptTokens,
    completionTokens: execution.usage.completionTokens,
    estimatedCostMicros: execution.usage.estimatedCostMicros,
    failureReason: execution.failureReason,
    createdAt: new Date().toISOString(),
  });
}

export async function executeAndPersistSemanticAnalysis(
  input: {
    runId: string;
    changed: SemanticArtifactSnapshot;
    candidates: SemanticArtifactSnapshot[];
    contexts?: SemanticContext;
    analyzer?: SemanticAnalyzer;
  },
  db: SpecGraphDb = getDb(),
): Promise<SemanticPersistenceResult> {
  const eligibleSnapshots = input.candidates.filter((candidate) =>
    shouldCreateImpactFinding(input.changed.kind, candidate.kind),
  );
  const candidates = generateSemanticCandidates(
    input.changed,
    eligibleSnapshots,
    input.contexts,
  );
  const semanticInput = buildSemanticAnalysisInput(
    input.runId,
    input.changed,
    candidates,
  );
  const execution = await executeSemanticAnalysis(semanticInput, input.analyzer);
  await recordAttempt(input.runId, input.changed.nodeId, execution, db);

  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  let persistedFindings = 0;
  const now = new Date().toISOString();
  for (const decision of execution.accepted) {
    const candidate = candidateById.get(decision.candidateId);
    if (!candidate) continue;
    const origin = candidate.relationshipContext.length ? "hybrid" : "semantic";
    const deduplicationKey = `${input.changed.nodeId}:${candidate.artifact.artifactId}:semantic:${execution.analyzerVersion}`;
    const impactFingerprint = await createImpactFingerprint({
      changed: {
        nodeId: input.changed.nodeId,
        revision: input.changed.revision,
      },
      affected: {
        artifactId: candidate.artifact.artifactId,
        revision: candidate.artifact.revision,
      },
      relationship: {
        origin,
        provenance: "SEMANTIC",
        analyzerVersion: execution.analyzerVersion,
        signals: candidate.relationshipContext.map((signal) => ({
          type: signal.type,
          origin: signal.origin,
          provenance: signal.provenance || "LEGACY",
          analyzerVersion: execution.analyzerVersion,
          evidence: signal.evidence,
          evidenceStartLine: null,
        })),
      },
      evidence: {
        location: `${candidate.artifact.path}:${decision.candidateStartLine}`,
        excerpt: decision.candidateExcerpt || "",
      },
    });
    const stableSuffix = (await sha256Hex(`${input.runId}:${deduplicationKey}`)).slice(0, 32);
    const relationshipId = `relationship_semantic_${stableSuffix}`;

    await db.insert(relationships).values({
      id: relationshipId,
      fromNodeId: input.changed.nodeId,
      toNodeId: candidate.artifact.nodeId,
      type: "semantic_impact",
      origin,
      provenance: "SEMANTIC",
      analyzerVersion: execution.analyzerVersion,
      confidence: decision.confidence,
      evidence: decision.candidateExcerpt || "",
      evidenceStartLine: decision.candidateStartLine,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [
        relationships.fromNodeId,
        relationships.toNodeId,
        relationships.type,
        relationships.origin,
      ],
      set: {
        analyzerVersion: execution.analyzerVersion,
        confidence: decision.confidence,
        evidence: decision.candidateExcerpt || "",
        evidenceStartLine: decision.candidateStartLine,
        updatedAt: now,
      },
    });

    const inserted = await db.insert(findings).values({
      id: `finding_${stableSuffix}`,
      runId: input.runId,
      changedNodeId: input.changed.nodeId,
      affectedNodeId: candidate.artifact.nodeId,
      title: candidate.artifact.path,
      summary: decision.summary,
      confidence: decision.confidence,
      origin,
      provenance: "SEMANTIC",
      analyzerVersion: execution.analyzerVersion,
      status: "open",
      deduplicationKey,
      impactFingerprint,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().returning({ id: findings.id });
    const findingId = inserted[0]?.id;
    if (!findingId) continue;

    const [version] = await db
      .select({ id: artifactVersions.id })
      .from(artifactVersions)
      .where(and(
        eq(artifactVersions.artifactId, candidate.artifact.artifactId),
        eq(artifactVersions.revision, candidate.artifact.revision),
      ))
      .limit(1);
    await db.insert(findingEvidence).values({
      id: `evidence_${stableSuffix}`,
      findingId,
      artifactVersionId: version?.id || null,
      location: `${candidate.artifact.path}:${decision.candidateStartLine}`,
      startLine: decision.candidateStartLine,
      endLine: decision.candidateStartLine +
        Math.max(0, (decision.candidateExcerpt || "").split("\n").length - 1),
      excerpt: decision.candidateExcerpt || "",
      sourceUrl: sourceLineUrl(candidate.artifact, decision.candidateStartLine),
      type: "semantic",
      createdAt: now,
    });
    persistedFindings += 1;
  }

  return { execution, persistedFindings };
}
