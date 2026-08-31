import { and, eq, inArray } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import {
  artifacts,
  artifactVersions,
  findings,
  graphNodes,
  sources,
} from "../../db/schema";
import { sourceIdsConnectedTo } from "../providers/source-groups";
import type { AnalysisChangeScope } from "./change-scope";
import {
  executeAndPersistSemanticAnalysis,
  type SemanticPersistenceResult,
} from "./semantic-persistence";
import {
  type SemanticAnalyzer,
  type SemanticArtifactSnapshot,
} from "./semantic";

type RuntimeSnapshotRow = SemanticArtifactSnapshot & {
  sourceId: string;
  stableKey: string;
};

export type SemanticRuntimeResult = {
  availableScopes: number;
  attemptedScopes: number;
  persistedFindings: number;
  skippedReason:
    | "NO_CHANGED_SNAPSHOT"
    | "NO_AVAILABLE_SCOPE"
    | "MULTIPLE_AVAILABLE_SCOPES"
    | "NO_CANDIDATES"
    | null;
  executions: SemanticPersistenceResult["execution"][];
};

function isArtifactRoot(row: RuntimeSnapshotRow): boolean {
  return (
    row.stableKey === `file:${row.path}` ||
    row.stableKey.startsWith("page:")
  );
}

async function loadRuntimeSnapshots(
  workspaceId: string,
  sourceIds: string[],
  db: SpecGraphDb,
): Promise<RuntimeSnapshotRow[]> {
  if (!sourceIds.length) return [];
  const rows = await db
    .select({
      nodeId: graphNodes.id,
      artifactId: artifacts.id,
      sourceId: artifacts.sourceId,
      stableKey: graphNodes.stableKey,
      kind: artifacts.kind,
      path: artifacts.path,
      revision: artifactVersions.revision,
      sourceUrl: artifacts.canonicalUrl,
      text: artifactVersions.extractedText,
    })
    .from(graphNodes)
    .innerJoin(artifacts, eq(graphNodes.artifactId, artifacts.id))
    .innerJoin(sources, eq(artifacts.sourceId, sources.id))
    .innerJoin(
      artifactVersions,
      and(
        eq(artifactVersions.artifactId, artifacts.id),
        eq(artifactVersions.revision, artifacts.currentRevision),
      ),
    )
    .where(
      and(
        eq(sources.workspaceId, workspaceId),
        eq(sources.status, "connected"),
        inArray(artifacts.sourceId, sourceIds),
      ),
    );

  const roots = rows.filter(isArtifactRoot);
  const uniqueByArtifact = new Map<string, RuntimeSnapshotRow>();
  for (const row of roots) uniqueByArtifact.set(row.artifactId, row);
  return [...uniqueByArtifact.values()];
}

async function affectedArtifactIdsForRun(
  runId: string,
  db: SpecGraphDb,
): Promise<Set<string>> {
  const rows = await db
    .select({ artifactId: graphNodes.artifactId })
    .from(findings)
    .innerJoin(graphNodes, eq(findings.affectedNodeId, graphNodes.id))
    .where(eq(findings.runId, runId));
  return new Set(rows.map((row) => row.artifactId));
}

/**
 * Runs the provider-neutral semantic layer for one changed artifact.
 *
 * The model never sees a workspace-wide dump. Retrieval is limited to current
 * root artifacts in the changed source's connected group, then the existing
 * semantic contract sends at most its top-three bounded candidates. Exact,
 * persisted change scopes remain the only changed text supplied to the model.
 */
export async function executeScopedSemanticAnalysis(
  input: {
    workspaceId: string;
    runId: string;
    changedSourceId: string;
    changedArtifactId: string;
    scopes: AnalysisChangeScope[];
    analyzer?: SemanticAnalyzer;
  },
  db: SpecGraphDb = getDb(),
): Promise<SemanticRuntimeResult> {
  const availableScopes = input.scopes.filter(
    (scope) =>
      scope.status === "available" &&
      scope.artifactId === input.changedArtifactId &&
      Boolean(scope.semanticText),
  );
  if (!availableScopes.length) {
    return {
      availableScopes: 0,
      attemptedScopes: 0,
      persistedFindings: 0,
      skippedReason: "NO_AVAILABLE_SCOPE",
      executions: [],
    };
  }
  // The first live rollout deliberately permits one atomic semantic decision
  // per manual run. A page edit with several distant hunks stays
  // deterministic-only instead of silently multiplying paid model requests.
  if (availableScopes.length > 1) {
    return {
      availableScopes: availableScopes.length,
      attemptedScopes: 0,
      persistedFindings: 0,
      skippedReason: "MULTIPLE_AVAILABLE_SCOPES",
      executions: [],
    };
  }

  const connectedSourceIds = await sourceIdsConnectedTo(
    input.workspaceId,
    [input.changedSourceId],
    db,
  );
  const snapshots = await loadRuntimeSnapshots(
    input.workspaceId,
    connectedSourceIds,
    db,
  );
  const changed = snapshots.find(
    (snapshot) => snapshot.artifactId === input.changedArtifactId,
  );
  if (!changed) {
    return {
      availableScopes: availableScopes.length,
      attemptedScopes: 0,
      persistedFindings: 0,
      skippedReason: "NO_CHANGED_SNAPSHOT",
      executions: [],
    };
  }

  const alreadyAffected = await affectedArtifactIdsForRun(input.runId, db);
  const scope = availableScopes[0]!;
  const candidates = snapshots.filter(
    (snapshot) =>
      snapshot.artifactId !== changed.artifactId &&
      !alreadyAffected.has(snapshot.artifactId),
  );
  const result = await executeAndPersistSemanticAnalysis({
    runId: input.runId,
    changed,
    changedScope: scope,
    candidates,
    analyzer: input.analyzer,
  }, db);

  return {
    availableScopes: availableScopes.length,
    attemptedScopes: result.execution.inputCandidateCount ? 1 : 0,
    persistedFindings: result.persistedFindings,
    skippedReason: result.execution.inputCandidateCount ? null : "NO_CANDIDATES",
    executions: [result.execution],
  };
}
