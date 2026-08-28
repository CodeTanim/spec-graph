import { sql } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";

export const ARTIFACT_VERSION_RETENTION = 3;

export async function pruneArtifactVersions(
  sourceId: string,
  db: SpecGraphDb = getDb(),
  keepPerArtifact = ARTIFACT_VERSION_RETENTION,
): Promise<void> {
  if (!Number.isInteger(keepPerArtifact) || keepPerArtifact < 1) {
    throw new Error("Artifact version retention must keep at least one revision.");
  }

  await db.execute(sql`
    delete from artifact_versions
    where id in (
      select id
      from (
        select
          artifact_versions.id,
          row_number() over (
            partition by artifact_versions.artifact_id
            order by artifact_versions.created_at desc, artifact_versions.id desc
          ) as revision_rank
        from artifact_versions
        inner join artifacts
          on artifacts.id = artifact_versions.artifact_id
        where artifacts.source_id = ${sourceId}
      ) ranked_versions
      where revision_rank > ${keepPerArtifact}
    )
  `);
}
