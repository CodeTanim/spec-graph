export function authorizeWorkspaceResource(sessionWorkspaceId: string, resourceWorkspaceId: string) {
  return sessionWorkspaceId === resourceWorkspaceId;
}
