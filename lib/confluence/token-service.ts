import { and, eq } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import { confluenceConnections } from "../../db/schema";
import { ApiError } from "../server/http";
import { decryptConnectorSecret, encryptConnectorSecret } from "./crypto";
import type { ConfluenceSourceProvider } from "./client";

export async function confluenceAccessToken(
  workspaceId: string,
  connectionId: string,
  encryptionKey: string,
  client: ConfluenceSourceProvider,
  db: SpecGraphDb = getDb(),
): Promise<string> {
  const [connection] = await db.select().from(confluenceConnections).where(and(
    eq(confluenceConnections.id, connectionId),
    eq(confluenceConnections.workspaceId, workspaceId),
  )).limit(1);
  if (!connection || connection.status === "disconnected") {
    throw new ApiError(404, "CONFLUENCE_CONNECTION_NOT_FOUND", "That Confluence connection was not found.");
  }
  if (new Date(connection.accessTokenExpiresAt).valueOf() > Date.now() + 60_000) {
    return decryptConnectorSecret(connection.encryptedAccessToken, encryptionKey);
  }
  if (!connection.encryptedRefreshToken) {
    throw new ApiError(401, "CONFLUENCE_REAUTHORIZE", "Reconnect Confluence to continue syncing.");
  }
  const refreshToken = await decryptConnectorSecret(connection.encryptedRefreshToken, encryptionKey);
  const refreshed = await client.refreshOAuthToken(refreshToken);
  const now = new Date();
  await db.update(confluenceConnections).set({
    encryptedAccessToken: await encryptConnectorSecret(refreshed.accessToken, encryptionKey),
    encryptedRefreshToken: await encryptConnectorSecret(refreshed.refreshToken || refreshToken, encryptionKey),
    accessTokenExpiresAt: new Date(now.valueOf() + refreshed.expiresIn * 1000).toISOString(),
    scopes: refreshed.scope || connection.scopes,
    status: "active",
    updatedAt: now.toISOString(),
  }).where(eq(confluenceConnections.id, connection.id));
  return refreshed.accessToken;
}
