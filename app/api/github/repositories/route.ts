import { getGitHubConnectionSession } from "../../../../lib/github/connection";
import { getRequestWorkspace } from "../../../../lib/server/current-workspace";
import { ApiError, apiErrorResponse } from "../../../../lib/server/http";

export async function GET(request: Request) {
  try {
    const { workspace, user } = await getRequestWorkspace(request);
    const state = new URL(request.url).searchParams.get("session") || "";
    if (!state) {
      throw new ApiError(400, "GITHUB_SESSION_REQUIRED", "GitHub connection is missing.");
    }
    const session = await getGitHubConnectionSession(
      state,
      workspace.id,
      user.databaseId,
    );
    return Response.json({
      items: session.items,
      expiresAt: session.expiresAt,
      sourceGroupId: session.sourceGroupId,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
