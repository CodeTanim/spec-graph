import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpecGraphDb } from "../db";
import * as schema from "../db/schema";
import { artifactVersions, artifacts, sources, workspaces } from "../db/schema";
import { pruneArtifactVersions } from "../lib/providers/version-retention";

let client: PGlite;
let db: SpecGraphDb;

beforeEach(async () => {
  client = new PGlite();
  const testDb = drizzle(client, { schema });
  await migrate(testDb, { migrationsFolder: "drizzle-postgres" });
  db = testDb as unknown as SpecGraphDb;
});

afterEach(async () => {
  await client.close();
});

describe("artifact version retention", () => {
  it("keeps only the newest revisions for artifacts in the selected source", async () => {
    await db.insert(workspaces).values({ id: "workspace-retention", name: "Retention" });
    await db.insert(sources).values([
      {
        id: "source-retention",
        workspaceId: "workspace-retention",
        provider: "github",
        externalId: "repo-retention",
        name: "acme/specgraph",
        detail: "main",
        status: "connected",
      },
      {
        id: "source-other",
        workspaceId: "workspace-retention",
        provider: "github",
        externalId: "repo-other",
        name: "acme/other",
        detail: "main",
        status: "connected",
      },
    ]);
    await db.insert(artifacts).values([
      {
        id: "artifact-retention",
        sourceId: "source-retention",
        externalId: "app/page.tsx",
        kind: "code",
        path: "app/page.tsx",
        title: "page.tsx",
      },
      {
        id: "artifact-other",
        sourceId: "source-other",
        externalId: "README.md",
        kind: "markdown",
        path: "README.md",
        title: "README.md",
      },
    ]);
    await db.insert(artifactVersions).values([
      ...[1, 2, 3, 4].map((revision) => ({
        id: `version-${revision}`,
        artifactId: "artifact-retention",
        revision: String(revision),
        contentHash: `hash-${revision}`,
        extractedText: `revision ${revision}`,
        createdAt: `2026-08-0${revision}T00:00:00.000Z`,
      })),
      {
        id: "version-other",
        artifactId: "artifact-other",
        revision: "1",
        contentHash: "hash-other",
        extractedText: "other source",
        createdAt: "2026-08-01T00:00:00.000Z",
      },
    ]);

    await pruneArtifactVersions("source-retention", db, 2);

    const retained = await db
      .select({ id: artifactVersions.id })
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, "artifact-retention"));
    const untouched = await db
      .select({ id: artifactVersions.id })
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, "artifact-other"));

    expect(retained.map((item) => item.id).sort()).toEqual(["version-3", "version-4"]);
    expect(untouched.map((item) => item.id)).toEqual(["version-other"]);
  });
});
