import { and, eq } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import { providerConnectionSessions } from "../../db/schema";
import { ApiError } from "../server/http";
import {
  sourceGroupIdForSource,
  sourceIdsForGroup,
} from "../providers/source-groups";
import { randomToken, sha256Hex } from "./crypto";
import type { GitHubRepositoryCandidate } from "./types";

const SESSION_MINUTES = 15;

export async function createGitHubConnectionSession(
  workspaceId: string,
  userId: string,
  sourceGroupId: string | null = null,
  db: SpecGraphDb = getDb(),
): Promise<{ state: string; expiresAt: string }> {
  if (sourceGroupId) {
    await sourceIdsForGroup(workspaceId, sourceGroupId, db);
  }
  const state = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.valueOf() + SESSION_MINUTES * 60_000).toISOString();
  await db.insert(providerConnectionSessions).values({
    id: `gcs_${crypto.randomUUID()}`,
    workspaceId,
    userId,
    provider: "github",
    stateHash: await sha256Hex(state),
    contextJson: JSON.stringify({ sourceGroupId }),
    status: "initiated",
    expiresAt,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  return { state, expiresAt };
}

async function sessionForState(
  state: string,
  workspaceId: string,
  userId: string,
  db: SpecGraphDb,
) {
  const [session] = await db
    .select()
    .from(providerConnectionSessions)
    .where(
      and(
        eq(providerConnectionSessions.stateHash, await sha256Hex(state)),
        eq(providerConnectionSessions.workspaceId, workspaceId),
        eq(providerConnectionSessions.userId, userId),
        eq(providerConnectionSessions.provider, "github"),
      ),
    )
    .limit(1);
  if (!session || new Date(session.expiresAt).valueOf() <= Date.now()) {
    throw new ApiError(
      400,
      "GITHUB_SESSION_EXPIRED",
      "That GitHub connection expired. Start again.",
    );
  }
  return session;
}

export async function authorizeGitHubConnectionSession(
  state: string,
  workspaceId: string,
  userId: string,
  candidates: GitHubRepositoryCandidate[],
  db: SpecGraphDb = getDb(),
): Promise<void> {
  const session = await sessionForState(state, workspaceId, userId, db);
  if (
    (session.status === "authorized" || session.status === "consumed") &&
    session.candidatesJson
  ) {
    return;
  }
  if (session.status !== "initiated") {
    throw new ApiError(409, "GITHUB_SESSION_USED", "That GitHub connection was already used.");
  }
  await db
    .update(providerConnectionSessions)
    .set({
      candidatesJson: JSON.stringify(candidates),
      status: "authorized",
      updatedAt: new Date().toISOString(),
    })
    .where(eq(providerConnectionSessions.id, session.id));
}

export async function getGitHubConnectionSession(
  state: string,
  workspaceId: string,
  userId: string,
  db: SpecGraphDb = getDb(),
): Promise<{
  id: string;
  items: GitHubRepositoryCandidate[];
  expiresAt: string;
  sourceGroupId: string | null;
}> {
  const session = await sessionForState(state, workspaceId, userId, db);
  if (
    (session.status !== "authorized" && session.status !== "consumed") ||
    !session.candidatesJson
  ) {
    throw new ApiError(409, "GITHUB_SESSION_NOT_READY", "GitHub authorization is incomplete.");
  }
  let items: GitHubRepositoryCandidate[];
  try {
    items = JSON.parse(session.candidatesJson) as GitHubRepositoryCandidate[];
  } catch {
    throw new ApiError(500, "GITHUB_SESSION_INVALID", "GitHub connection data is invalid.");
  }
  let sourceGroupId: string | null = null;
  try {
    const context = session.contextJson
      ? (JSON.parse(session.contextJson) as {
          sourceGroupId?: string;
          documentationSourceId?: string;
        })
      : {};
    sourceGroupId = context.sourceGroupId || null;
    if (!sourceGroupId && context.documentationSourceId) {
      sourceGroupId = await sourceGroupIdForSource(
        workspaceId,
        context.documentationSourceId,
        db,
      );
    }
  } catch {
    throw new ApiError(500, "GITHUB_SESSION_INVALID", "GitHub connection data is invalid.");
  }
  return { id: session.id, items, expiresAt: session.expiresAt, sourceGroupId };
}

export async function hasAuthorizedGitHubConnectionSession(
  state: string,
  workspaceId: string,
  userId: string,
  db: SpecGraphDb = getDb(),
): Promise<boolean> {
  const session = await sessionForState(state, workspaceId, userId, db);
  return (
    (session.status === "authorized" || session.status === "consumed") &&
    Boolean(session.candidatesJson)
  );
}

export async function consumeGitHubConnectionSession(
  id: string,
  db: SpecGraphDb = getDb(),
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(providerConnectionSessions)
    .set({ status: "consumed", consumedAt: now, updatedAt: now })
    .where(eq(providerConnectionSessions.id, id));
}
