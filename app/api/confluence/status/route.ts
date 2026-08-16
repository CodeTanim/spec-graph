import { getConfluenceConfig } from "../../../../lib/confluence/config";
import { getRequestWorkspace } from "../../../../lib/server/current-workspace";
import { apiErrorResponse } from "../../../../lib/server/http";

export async function GET(request: Request) {
  try {
    await getRequestWorkspace(request);
    try {
      getConfluenceConfig();
      return Response.json({ configured: true });
    } catch {
      return Response.json({ configured: false });
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
