import { and, eq, inArray, or } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import {
  artifacts,
  artifactVersions,
  confluenceConnections,
  graphNodes,
  relationships,
  sources,
} from "../../db/schema";
import { contentHash } from "../github/crypto";
import { ApiError } from "../server/http";
import type { ConfluenceSourceProvider } from "./client";
import { confluenceAccessToken } from "./token-service";

const MAX_PAGES = 100;
const MAX_PAGE_BYTES = 250_000;

function plainText(storage: string): string {
  return storage
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/li>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function pageUrl(siteUrl: string, webPath: string | null, spaceKey: string, pageId: string) {
  if (webPath) return new URL(webPath, siteUrl).toString();
  return `${siteUrl.replace(/\/$/, "")}/wiki/spaces/${encodeURIComponent(spaceKey)}/pages/${encodeURIComponent(pageId)}`;
}

export async function syncConfluenceSource(
  workspaceId: string,
  sourceId: string,
  encryptionKey: string,
  client: ConfluenceSourceProvider,
  db: SpecGraphDb = getDb(),
): Promise<{ artifactCount: number; revision: string }> {
  const [record] = await db.select({ source: sources, connection: confluenceConnections })
    .from(sources)
    .innerJoin(confluenceConnections, eq(sources.confluenceConnectionId, confluenceConnections.id))
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)))
    .limit(1);
  if (!record || record.source.provider !== "confluence") {
    throw new ApiError(404, "SOURCE_NOT_FOUND", "That Confluence source was not found.");
  }
  const spaceId = record.source.externalId.split(":space:")[1];
  const spaceKey = record.source.detail.split(" / ").at(-1) || record.source.detail;
  if (!spaceId) throw new ApiError(500, "CONFLUENCE_SOURCE_INVALID", "This Confluence source is invalid.");
  const now = new Date().toISOString();
  await db.update(sources).set({ status: "syncing", lastError: null, updatedAt: now })
    .where(eq(sources.id, sourceId));
  try {
    const accessToken = await confluenceAccessToken(
      workspaceId,
      record.connection.id,
      encryptionKey,
      client,
      db,
    );
    const pages = await client.pages(accessToken, record.connection.cloudId, spaceId);
    if (pages.length > MAX_PAGES) {
      throw new ApiError(413, "CONFLUENCE_PAGE_LIMIT", `This MVP indexes up to ${MAX_PAGES} pages per space.`);
    }
    if (pages.some((page) => new TextEncoder().encode(page.bodyStorage).byteLength > MAX_PAGE_BYTES)) {
      throw new ApiError(413, "CONFLUENCE_PAGE_SIZE_LIMIT", "A Confluence page exceeds the current MVP size limit.");
    }
    const existingArtifacts = await db.select().from(artifacts).where(eq(artifacts.sourceId, sourceId));
    const existingByPage = new Map(existingArtifacts.map((item) => [item.externalId, item]));
    const nodeIds: string[] = [];
    let latestVersion = 0;

    for (const page of pages) {
      latestVersion = Math.max(latestVersion, page.version);
      const text = plainText(page.bodyStorage);
      const hash = await contentHash(text);
      const revision = String(page.version);
      const existing = existingByPage.get(page.id);
      const artifactId = existing?.id || `art_${crypto.randomUUID()}`;
      const canonicalUrl = pageUrl(record.connection.siteUrl, page.webPath, spaceKey, page.id);
      await db.insert(artifacts).values({
        id: artifactId,
        sourceId,
        externalId: page.id,
        kind: "confluence",
        path: `${spaceKey}/${page.title}`,
        title: page.title,
        canonicalUrl,
        currentRevision: revision,
        contentHash: hash,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [artifacts.sourceId, artifacts.externalId],
        set: {
          path: `${spaceKey}/${page.title}`,
          title: page.title,
          canonicalUrl,
          currentRevision: revision,
          contentHash: hash,
          updatedAt: now,
        },
      });
      await db.insert(artifactVersions).values({
        id: `ver_${crypto.randomUUID()}`,
        artifactId,
        revision,
        contentHash: hash,
        extractedText: text,
        createdAt: now,
      }).onConflictDoNothing({ target: [artifactVersions.artifactId, artifactVersions.revision] });

      const [existingNode] = await db.select().from(graphNodes).where(and(
        eq(graphNodes.artifactId, artifactId),
        eq(graphNodes.stableKey, `page:${page.id}`),
      )).limit(1);
      const nodeId = existingNode?.id || `node_${crypto.randomUUID()}`;
      await db.insert(graphNodes).values({
        id: nodeId,
        artifactId,
        stableKey: `page:${page.id}`,
        kind: "doc_section",
        name: page.title,
        startLine: 1,
        endLine: Math.max(1, text.split("\n").length),
        contentHash: hash,
        createdAt: existingNode?.createdAt || now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [graphNodes.artifactId, graphNodes.stableKey],
        set: { name: page.title, endLine: Math.max(1, text.split("\n").length), contentHash: hash, updatedAt: now },
      });
      nodeIds.push(nodeId);
    }

    const currentPages = new Set(pages.map((page) => page.id));
    for (const existing of existingArtifacts) {
      if (!currentPages.has(existing.externalId)) await db.delete(artifacts).where(eq(artifacts.id, existing.id));
    }
    if (nodeIds.length) {
      await db.delete(relationships).where(or(
        inArray(relationships.fromNodeId, nodeIds),
        inArray(relationships.toNodeId, nodeIds),
      ));
    }

    const revision = String(latestVersion);
    await db.update(sources).set({
      status: "connected",
      currentRevision: revision,
      lastError: null,
      lastSyncedAt: now,
      updatedAt: now,
    }).where(eq(sources.id, sourceId));
    return { artifactCount: pages.length, revision };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Confluence synchronization failed.";
    await db.update(sources).set({ status: "error", lastError: message, updatedAt: new Date().toISOString() })
      .where(eq(sources.id, sourceId));
    throw error;
  }
}
