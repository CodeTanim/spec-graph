import { GitHubClient } from "../../../../lib/github/client";
import { getGitHubAppConfig } from "../../../../lib/github/config";
import { connectGitHubSource } from "../../../../lib/github/source-service";
import { getRequestWorkspace } from "../../../../lib/server/current-workspace";
import { ApiError, apiErrorResponse, readJsonObject } from "../../../../lib/server/http";
import { sourceSyncWorkflow } from "../../../../workflows/source-sync";
import { start } from "workflow/api";

export async function POST(request: Request) {
  try {
    const { workspace, user } = await getRequestWorkspace(request);
    const body = await readJsonObject(request);
    const sessionState = typeof body.sessionState === "string" ? body.sessionState : "";
    const repositoryId = typeof body.repositoryId === "string" ? body.repositoryId : "";
    const branch = typeof body.branch === "string" ? body.branch : "";
    if (!sessionState || !repositoryId || !branch) {
      throw new ApiError(
        400,
        "GITHUB_SOURCE_INVALID",
        "Choose a repository and branch.",
      );
    }
    const client = new GitHubClient(getGitHubAppConfig());
    const result = await connectGitHubSource(
        workspace.id,
        user.databaseId,
        { sessionState, repositoryId, branch },
        client,
      );
    await start(sourceSyncWorkflow, [workspace.id, result.source.id]);
    return Response.json(result, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
