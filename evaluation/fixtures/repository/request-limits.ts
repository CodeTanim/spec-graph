export function authorizeBoundedRequest(input: {
  workspaceId: string;
  authenticatedWorkspaceId: string;
  recentRequestCount: number;
}) {
  return {
    authorized: input.workspaceId === input.authenticatedWorkspaceId,
    withinRateLimit: input.recentRequestCount < 20,
  };
}
