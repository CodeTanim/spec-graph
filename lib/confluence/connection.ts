import { and, eq } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import { confluenceConnections, providerConnectionSessions } from "../../db/schema";
import type { ConfluenceSpaceCandidate } from "../contracts/specgraph";
import { randomToken, sha256Hex } from "../github/crypto";
import { ApiError } from "../server/http";
import { encryptConnectorSecret } from "./crypto";
import type { ConfluenceAccessibleResource, ConfluenceOAuthToken } from "./types";

const SESSION_MINUTES = 15;

type ConfluenceSessionContext = { repositorySourceId: string | null };

export async function createConfluenceConnectionSession(
  workspaceId: string,
  userId: string,
  repositorySourceId: string | null,
  db: SpecGraphDb = getDb(),
): Promise<{ state: string; expiresAt: string }> {
  const state = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.valueOf() + SESSION_MINUTES * 60_000).toISOString();
  await db.insert(providerConnectionSessions).values({
    id: `ccs_${crypto.randomUUID()}`,
    workspaceId,
    userId,
    provider: "confluence",
    stateHash: await sha256Hex(state),
    contextJson: JSON.stringify({ repositorySourceId }),
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
  const [session] = await db.select().from(providerConnectionSessions).where(and(
    eq(providerConnectionSessions.stateHash, await sha256Hex(state)),
    eq(providerConnectionSessions.workspaceId, workspaceId),
    eq(providerConnectionSessions.userId, userId),
    eq(providerConnectionSessions.provider, "confluence"),
  )).limit(1);
  if (!session || new Date(session.expiresAt).valueOf() <= Date.now()) {
    throw new ApiError(400, "CONFLUENCE_SESSION_EXPIRED", "That Confluence connection expired. Start again.");
  }
  return session;
}

export async function authorizeConfluenceConnectionSession(
  state: string,
  workspaceId: string,
  userId: string,
  token: ConfluenceOAuthToken,
  resources: Array<{ resource: ConfluenceAccessibleResource; spaces: Array<{ id: string; key: string; name: string }> }>,
  encryptionKey: string,
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
    throw new ApiError(409, "CONFLUENCE_SESSION_USED", "That Confluence connection was already used.");
  }
  const now = new Date();
  const encryptedAccessToken = await encryptConnectorSecret(token.accessToken, encryptionKey);
  const encryptedRefreshToken = token.refreshToken
    ? await encryptConnectorSecret(token.refreshToken, encryptionKey)
    : null;
  const expiresAt = new Date(now.valueOf() + token.expiresIn * 1000).toISOString();

  for (const { resource } of resources) {
    await db.insert(confluenceConnections).values({
      id: `cfc_${crypto.randomUUID()}`,
      workspaceId,
      cloudId: resource.id,
      siteName: resource.name,
      siteUrl: resource.url,
      encryptedAccessToken,
      encryptedRefreshToken,
      accessTokenExpiresAt: expiresAt,
      scopes: token.scope || resource.scopes.join(" "),
      status: "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }).onConflictDoUpdate({
      target: [confluenceConnections.workspaceId, confluenceConnections.cloudId],
      set: {
        siteName: resource.name,
        siteUrl: resource.url,
        encryptedAccessToken,
        encryptedRefreshToken,
        accessTokenExpiresAt: expiresAt,
        scopes: token.scope || resource.scopes.join(" "),
        status: "active",
        updatedAt: now.toISOString(),
      },
    });
  }

  const candidates: ConfluenceSpaceCandidate[] = resources.flatMap(({ resource, spaces }) =>
    spaces.map((space) => ({
      id: space.id,
      key: space.key,
      name: space.name,
      cloudId: resource.id,
      siteName: resource.name,
      siteUrl: resource.url,
    })),
  );
  await db.update(providerConnectionSessions).set({
    candidatesJson: JSON.stringify(candidates),
    status: "authorized",
    updatedAt: now.toISOString(),
  }).where(eq(providerConnectionSessions.id, session.id));
}

export async function getConfluenceConnectionSession(
  state: string,
  workspaceId: string,
  userId: string,
  db: SpecGraphDb = getDb(),
): Promise<{
  id: string;
  items: ConfluenceSpaceCandidate[];
  expiresAt: string;
  repositorySourceId: string | null;
}> {
  const session = await sessionForState(state, workspaceId, userId, db);
  if (
    (session.status !== "authorized" && session.status !== "consumed") ||
    !session.candidatesJson
  ) {
    throw new ApiError(409, "CONFLUENCE_SESSION_NOT_READY", "Confluence authorization is incomplete.");
  }
  try {
    const context = session.contextJson
      ? JSON.parse(session.contextJson) as ConfluenceSessionContext
      : { repositorySourceId: null };
    return {
      id: session.id,
      items: JSON.parse(session.candidatesJson) as ConfluenceSpaceCandidate[],
      expiresAt: session.expiresAt,
      repositorySourceId: context.repositorySourceId || null,
    };
  } catch {
    throw new ApiError(500, "CONFLUENCE_SESSION_INVALID", "Confluence connection data is invalid.");
  }
}

export async function hasAuthorizedConfluenceConnectionSession(
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

export async function consumeConfluenceConnectionSession(id: string, db: SpecGraphDb = getDb()) {
  const now = new Date().toISOString();
  await db.update(providerConnectionSessions).set({ status: "consumed", consumedAt: now, updatedAt: now })
    .where(eq(providerConnectionSessions.id, id));
}
