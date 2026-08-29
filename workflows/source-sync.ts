import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { sources } from "../db/schema";
import { ConfluenceClient } from "../lib/confluence/client";
import { getConfluenceConfig } from "../lib/confluence/config";
import { syncConfluenceSource } from "../lib/confluence/ingestion";
import { GitHubClient } from "../lib/github/client";
import { getGitHubAppConfig } from "../lib/github/config";
import { syncGitHubSource } from "../lib/github/ingestion";
import { rebuildCrossSourceRelationships } from "../lib/providers/cross-source-relationships";
import { getSource } from "../lib/server/specgraph-repository";

export async function sourceSyncWorkflow(
  workspaceId: string,
  sourceId: string,
) {
  "use workflow";

  await syncSourceStep(workspaceId, sourceId);
}

export async function syncSourceStep(workspaceId: string, sourceId: string) {
  "use step";

  const db = getDb();
  const source = await getSource(workspaceId, sourceId, db);
  try {
    let changed = false;
    if (source.provider === "github") {
      const result = await syncGitHubSource(
        workspaceId,
        sourceId,
        new GitHubClient(getGitHubAppConfig()),
        db,
      );
      changed = result.changed;
    } else {
      const config = getConfluenceConfig();
      const result = await syncConfluenceSource(
        workspaceId,
        sourceId,
        config.encryptionKey,
        new ConfluenceClient(config),
        db,
      );
      changed = result.changed;
    }
    if (changed) {
      await rebuildCrossSourceRelationships(workspaceId, sourceId, db);
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Source synchronization failed.";
    const now = new Date().toISOString();
    await db
      .update(sources)
      .set({ status: "error", lastError: message, updatedAt: now })
      .where(eq(sources.id, sourceId));
    throw error;
  }
}

syncSourceStep.maxRetries = 2;
