import { and, eq } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import { githubInstallations, sources } from "../../db/schema";
import type {
  ConnectGitHubSourceInput,
  ConnectGitHubSourceResponse,
} from "../contracts/specgraph";
import { ApiError } from "../server/http";
import { getSource } from "../server/specgraph-repository";
import { getGitHubConnectionSession, consumeGitHubConnectionSession } from "./connection";
import type { GitHubSourceProvider } from "../providers/source-provider";
import { syncGitHubSource } from "./ingestion";
import { associateSources } from "../providers/source-associations";
import { rebuildCrossSourceRelationships } from "../providers/cross-source-relationships";

export async function connectGitHubSource(
  workspaceId: string,
  userId: string,
  input: ConnectGitHubSourceInput,
  client: GitHubSourceProvider,
  db: SpecGraphDb = getDb(),
): Promise<ConnectGitHubSourceResponse> {
  const branch = input.branch.trim();
  if (!branch || branch.length > 255 || /[\x00-\x20~^:?*[\\]/.test(branch)) {
    throw new ApiError(400, "INVALID_BRANCH", "Choose a valid GitHub branch.");
  }
  const session = await getGitHubConnectionSession(
    input.sessionState,
    workspaceId,
    userId,
    db,
  );
  const candidate = session.items.find((item) => item.id === input.repositoryId);
  if (!candidate) {
    throw new ApiError(
      404,
      "REPOSITORY_NOT_AUTHORIZED",
      "That repository is not available in this GitHub connection.",
    );
  }

  await client.branchRevision(candidate.installationId, candidate.fullName, branch);
  const now = new Date().toISOString();
  const [existingSource] = await db
    .select()
    .from(sources)
    .where(and(
      eq(sources.workspaceId, workspaceId),
      eq(sources.provider, "github"),
      eq(sources.externalId, candidate.id),
    ))
    .limit(1);
  const alreadyTracked = Boolean(existingSource);
  await db
    .insert(githubInstallations)
    .values({
      id: `ghi_${crypto.randomUUID()}`,
      workspaceId,
      externalInstallationId: candidate.installationId,
      accountLogin: candidate.accountLogin,
      accountType: candidate.accountType,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        githubInstallations.workspaceId,
        githubInstallations.externalInstallationId,
      ],
      set: {
        accountLogin: candidate.accountLogin,
        accountType: candidate.accountType,
        status: "active",
        updatedAt: now,
      },
    });
  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.workspaceId, workspaceId),
        eq(githubInstallations.externalInstallationId, candidate.installationId),
      ),
    )
    .limit(1);
  if (!installation) {
    throw new ApiError(500, "GITHUB_INSTALLATION_FAILED", "GitHub setup could not be saved.");
  }

  await db
    .insert(sources)
    .values({
      id: `src_${crypto.randomUUID()}`,
      workspaceId,
      githubInstallationId: installation.id,
      provider: "github",
      externalId: candidate.id,
      name: candidate.fullName,
      detail: branch,
      canonicalUrl: `https://github.com/${candidate.fullName}`,
      defaultBranch: branch,
      status: "syncing",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [sources.workspaceId, sources.provider, sources.externalId],
      set: {
        githubInstallationId: installation.id,
        name: candidate.fullName,
        detail: branch,
        canonicalUrl: `https://github.com/${candidate.fullName}`,
        defaultBranch: branch,
        status: "syncing",
        lastError: null,
        updatedAt: now,
      },
    });
  const [source] = await db
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.workspaceId, workspaceId),
        eq(sources.provider, "github"),
        eq(sources.externalId, candidate.id),
      ),
    )
    .limit(1);
  if (!source) {
    throw new ApiError(500, "SOURCE_SETUP_FAILED", "The repository could not be saved.");
  }
  await consumeGitHubConnectionSession(session.id, db);
  let associationAlreadyTracked = false;
  const documentationSourceId = input.documentationSourceId || session.documentationSourceId;
  if (documentationSourceId) {
    associationAlreadyTracked = (
      await associateSources(workspaceId, source.id, documentationSourceId, db)
    ).alreadyTracked;
  }
  await syncGitHubSource(workspaceId, source.id, client, db);
  await rebuildCrossSourceRelationships(workspaceId, source.id, db);
  return {
    source: await getSource(workspaceId, source.id, db),
    alreadyTracked,
    associationAlreadyTracked,
  };
}
