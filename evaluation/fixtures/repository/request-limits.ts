import { authorizeWorkspaceResource } from "./workspace-auth";

export function authorizeBoundedRequest(input: {
  workspaceId: string;
  authenticatedWorkspaceId: string;
  recentRequestCount: number;
}) {
  return {
    authorized: authorizeWorkspaceResource(
      input.authenticatedWorkspaceId,
      input.workspaceId,
    ),
    withinRateLimit: input.recentRequestCount < 20,
  };
}
