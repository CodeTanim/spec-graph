import { getCurrentIdentity } from "../auth/current-user";
import { getDb, type SpecGraphDb } from "../../db";
import { ApiError } from "./http";
import {
  ensureWorkspaceForUser,
  type WorkspaceContext,
} from "./workspace-provisioning";

export type { WorkspaceContext } from "./workspace-provisioning";

export async function getRequestWorkspace(
  request: Request,
  db: SpecGraphDb = getDb(),
): Promise<WorkspaceContext> {
  const identity = await getCurrentIdentity(request);

  if (!identity) {
    throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Sign in to use SpecGraph.");
  }

  return ensureWorkspaceForUser(identity, db);
}
