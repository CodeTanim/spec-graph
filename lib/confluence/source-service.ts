import { and, eq } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import { confluenceConnections, sources } from "../../db/schema";
import type { ConnectConfluenceSourceInput, ConnectConfluenceSourceResponse } from "../contracts/specgraph";
import { associateSources } from "../providers/source-associations";
import { ApiError } from "../server/http";
import { getSource } from "../server/specgraph-repository";
import { consumeConfluenceConnectionSession, getConfluenceConnectionSession } from "./connection";

export async function connectConfluenceSource(
  workspaceId: string,
  userId: string,
  input: ConnectConfluenceSourceInput,
  db: SpecGraphDb = getDb(),
): Promise<ConnectConfluenceSourceResponse> {
  const session = await getConfluenceConnectionSession(input.sessionState, workspaceId, userId, db);
  const candidate = session.items.find((item) => item.id === input.spaceId);
  if (!candidate) {
    throw new ApiError(404, "CONFLUENCE_SPACE_NOT_AUTHORIZED", "That space is not available in this Confluence connection.");
  }
  const [connection] = await db.select().from(confluenceConnections).where(and(
    eq(confluenceConnections.workspaceId, workspaceId),
    eq(confluenceConnections.cloudId, candidate.cloudId),
  )).limit(1);
  if (!connection) throw new ApiError(500, "CONFLUENCE_CONNECTION_FAILED", "Confluence setup could not be saved.");

  const externalId = `${candidate.cloudId}:space:${candidate.id}`;
  const [existing] = await db.select().from(sources).where(and(
    eq(sources.workspaceId, workspaceId),
    eq(sources.provider, "confluence"),
    eq(sources.externalId, externalId),
  )).limit(1);
  const alreadyTracked = Boolean(existing);
  const now = new Date().toISOString();
  await db.insert(sources).values({
    id: `src_${crypto.randomUUID()}`,
    workspaceId,
    confluenceConnectionId: connection.id,
    provider: "confluence",
    externalId,
    name: candidate.name,
    detail: `${candidate.siteName} / ${candidate.key}`,
    canonicalUrl: `${candidate.siteUrl.replace(/\/$/, "")}/wiki/spaces/${encodeURIComponent(candidate.key)}`,
    status: "syncing",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [sources.workspaceId, sources.provider, sources.externalId],
    set: {
      confluenceConnectionId: connection.id,
      name: candidate.name,
      detail: `${candidate.siteName} / ${candidate.key}`,
      canonicalUrl: `${candidate.siteUrl.replace(/\/$/, "")}/wiki/spaces/${encodeURIComponent(candidate.key)}`,
      status: "syncing",
      lastError: null,
      updatedAt: now,
    },
  });
  const [source] = await db.select().from(sources).where(and(
    eq(sources.workspaceId, workspaceId),
    eq(sources.provider, "confluence"),
    eq(sources.externalId, externalId),
  )).limit(1);
  if (!source) throw new ApiError(500, "SOURCE_SETUP_FAILED", "The Confluence space could not be saved.");

  const repositorySourceId = session.repositorySourceId || input.repositorySourceId || null;
  let associationAlreadyTracked = false;
  let repositoryName: string | null = null;
  if (repositorySourceId) {
    const association = await associateSources(workspaceId, repositorySourceId, source.id, db);
    associationAlreadyTracked = association.alreadyTracked;
    repositoryName = association.repositoryName;
  }
  await consumeConfluenceConnectionSession(session.id, db);
  return {
    source: await getSource(workspaceId, source.id, db),
    alreadyTracked,
    associationAlreadyTracked,
    repositoryName,
  };
}
