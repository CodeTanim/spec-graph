import { eq } from "drizzle-orm";
import { readChatGPTUser, type ChatGPTUser } from "../../app/chatgpt-auth";
import { getDb, prepareDevelopmentDb, type SpecGraphDb } from "../../db";
import { users, workspaceMembers, workspaces } from "../../db/schema";
import { ApiError } from "./http";

export type WorkspaceContext = {
  user: ChatGPTUser & { databaseId: string };
  workspace: {
    id: string;
    name: string;
  };
};

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export async function ensureWorkspaceForUser(
  identity: ChatGPTUser,
  db: SpecGraphDb = getDb(),
): Promise<WorkspaceContext> {
  const now = new Date().toISOString();

  await db
    .insert(users)
    .values({
      id: newId("usr"),
      providerUserId: identity.id,
      email: identity.email,
      displayName: identity.displayName,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: users.providerUserId,
      set: {
        email: identity.email,
        displayName: identity.displayName,
        updatedAt: now,
      },
    });

  const [databaseUser] = await db
    .select()
    .from(users)
    .where(eq(users.providerUserId, identity.id))
    .limit(1);

  if (!databaseUser) {
    throw new ApiError(500, "USER_SETUP_FAILED", "SpecGraph could not prepare your account.");
  }

  const workspaceId = `ws_${databaseUser.id}`;
  const workspaceName = `${identity.displayName}'s workspace`;

  await db
    .insert(workspaces)
    .values({
      id: workspaceId,
      name: workspaceName,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: workspaces.id });

  await db
    .insert(workspaceMembers)
    .values({
      workspaceId,
      userId: databaseUser.id,
      role: "owner",
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [workspaceMembers.workspaceId, workspaceMembers.userId],
      set: { role: "owner" },
    });

  return {
    user: { ...identity, databaseId: databaseUser.id },
    workspace: { id: workspaceId, name: workspaceName },
  };
}

export async function getRequestWorkspace(
  request: Request,
  db: SpecGraphDb = getDb(),
): Promise<WorkspaceContext> {
  await prepareDevelopmentDb();
  const allowDevelopmentFallback = process.env.NODE_ENV !== "production";
  const identity = readChatGPTUser(request.headers, allowDevelopmentFallback);

  if (!identity) {
    throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Sign in to use SpecGraph.");
  }

  return ensureWorkspaceForUser(identity, db);
}
