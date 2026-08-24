import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import { artifacts, artifactVersions, graphNodes } from "../../db/schema";
import type { ChangedArtifact } from "../contracts/specgraph";
import type { ChangedGraphNode } from "../analysis/deterministic";
import { diffOpenApiContracts, type OpenApiChange } from "./parser";

type ResolvedGitHubChanges = {
  changedNodes: ChangedGraphNode[];
  openApiArtifacts: Map<string, ChangedArtifact[]>;
};

function anchoredUrl(url: string | null, line: number): string | null {
  return url ? `${url}#L${line}` : null;
}

function summarize(changes: OpenApiChange[]): string {
  const visible = changes.slice(0, 3).map((change) => change.summary);
  const remaining = changes.length - visible.length;
  return `${visible.join(" ")}${remaining > 0 ? ` ${remaining} more contract changes were detected.` : ""}`;
}

function enrichedArtifacts(
  path: string,
  canonicalUrl: string | null,
  changes: OpenApiChange[],
): ChangedArtifact[] {
  return changes.slice(0, 25).map((change) => ({
    id: `${path}:${change.stableKey}`,
    name: change.name,
    kind: "OpenAPI",
    location: `${path} · ${change.name}`,
    externalUrl: anchoredUrl(canonicalUrl, change.startLine),
  }));
}

export async function resolveGitHubChangedNodes(
  sourceId: string,
  changedPaths: string[],
  beforeRevision: string | null,
  afterRevision: string | null,
  db: SpecGraphDb = getDb(),
): Promise<ResolvedGitHubChanges> {
  if (!changedPaths.length) {
    return { changedNodes: [], openApiArtifacts: new Map() };
  }
  const rows = await db
    .select({
      artifactId: artifacts.id,
      path: artifacts.path,
      kind: artifacts.kind,
      canonicalUrl: artifacts.canonicalUrl,
      currentRevision: artifacts.currentRevision,
      nodeId: graphNodes.id,
      stableKey: graphNodes.stableKey,
    })
    .from(artifacts)
    .innerJoin(graphNodes, eq(graphNodes.artifactId, artifacts.id))
    .where(
      and(
        eq(artifacts.sourceId, sourceId),
        inArray(artifacts.path, changedPaths),
      ),
    );
  const records = rows.filter((row) => row.stableKey === `file:${row.path}`);
  const artifactIds = records.map((record) => record.artifactId);
  const versions = artifactIds.length
    ? await db
        .select()
        .from(artifactVersions)
        .where(inArray(artifactVersions.artifactId, artifactIds))
        .orderBy(desc(artifactVersions.createdAt))
    : [];
  const versionsByArtifact = new Map<string, typeof versions>();
  for (const version of versions) {
    const items = versionsByArtifact.get(version.artifactId) || [];
    items.push(version);
    versionsByArtifact.set(version.artifactId, items);
  }

  const changedNodes: ChangedGraphNode[] = [];
  const openApiArtifacts = new Map<string, ChangedArtifact[]>();
  for (const record of records) {
    if (record.kind !== "openapi") {
      changedNodes.push({ id: record.nodeId, path: record.path });
      continue;
    }
    const candidates = versionsByArtifact.get(record.artifactId) || [];
    const after =
      candidates.find((version) => version.revision === afterRevision) ||
      candidates.find((version) => version.revision === record.currentRevision) ||
      candidates[0];
    const before =
      candidates.find((version) => version.revision === beforeRevision) ||
      candidates.find((version) => version.id !== after?.id);
    if (!after) {
      changedNodes.push({ id: record.nodeId, path: record.path });
      continue;
    }
    try {
      const changes = diffOpenApiContracts(
        before?.extractedText || null,
        after.extractedText,
      );
      if (!changes.length) continue;
      changedNodes.push({
        id: record.nodeId,
        path: record.path,
        changeSummary: summarize(changes),
        changeKeys: [...new Set(changes.flatMap((change) => change.matchKeys))],
      });
      openApiArtifacts.set(
        record.path,
        enrichedArtifacts(record.path, record.canonicalUrl, changes),
      );
    } catch {
      // Invalid contracts remain visible as changed files but do not create
      // deterministic impact findings without trustworthy structured facts.
    }
  }
  return { changedNodes, openApiArtifacts };
}

export function enrichChangedArtifacts(
  serializedArtifacts: string,
  replacements: Map<string, ChangedArtifact[]>,
): string {
  if (!replacements.size) return serializedArtifacts;
  let existing: ChangedArtifact[];
  try {
    const parsed = JSON.parse(serializedArtifacts) as unknown;
    existing = Array.isArray(parsed) ? (parsed as ChangedArtifact[]) : [];
  } catch {
    existing = [];
  }
  return JSON.stringify(
    existing.flatMap((artifact) => replacements.get(artifact.location) || [artifact]),
  );
}
