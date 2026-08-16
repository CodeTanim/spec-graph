import { and, eq } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import { sourceAssociations, sources } from "../../db/schema";
import type { AssociateSourcesResponse } from "../contracts/specgraph";
import { ApiError } from "../server/http";

export async function associateSources(
  workspaceId: string,
  repositorySourceId: string,
  documentationSourceId: string,
  db: SpecGraphDb = getDb(),
): Promise<AssociateSourcesResponse> {
  if (repositorySourceId === documentationSourceId) {
    throw new ApiError(400, "SOURCE_PAIR_INVALID", "Choose a repository and documentation source.");
  }
  const rows = await db
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.workspaceId, workspaceId),
        // Both ids are verified below without trusting either client-provided provider.
      ),
    );
  const repository = rows.find((item) => item.id === repositorySourceId);
  const documentation = rows.find((item) => item.id === documentationSourceId);
  if (!repository || repository.provider !== "github") {
    throw new ApiError(404, "REPOSITORY_SOURCE_NOT_FOUND", "That repository was not found.");
  }
  if (!documentation || documentation.provider !== "confluence") {
    throw new ApiError(404, "DOCUMENTATION_SOURCE_NOT_FOUND", "That documentation source was not found.");
  }
  const now = new Date().toISOString();
  const inserted = await db.insert(sourceAssociations).values({
    id: `assoc_${crypto.randomUUID()}`,
    workspaceId,
    repositorySourceId,
    documentationSourceId,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing({
    target: [
      sourceAssociations.workspaceId,
      sourceAssociations.repositorySourceId,
      sourceAssociations.documentationSourceId,
    ],
  }).returning({ id: sourceAssociations.id });
  return { alreadyTracked: inserted.length === 0, repositoryName: repository.name };
}
