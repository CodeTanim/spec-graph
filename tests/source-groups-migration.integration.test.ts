import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migrationNames = [
  "0000_wonderful_silhouette.sql",
  "0001_closed_maggott.sql",
  "0002_smooth_living_mummy.sql",
  "0003_optimal_layla_miller.sql",
  "0004_freezing_sinister_six.sql",
];

async function applyMigration(client: PGlite, name: string) {
  const sql = await readFile(
    new URL(`../drizzle-postgres/${name}`, import.meta.url),
    "utf8",
  );
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.exec(statement);
  }
}

let client: PGlite;

beforeEach(() => {
  client = new PGlite();
});

afterEach(async () => {
  await client.close();
});

describe("source-group migration", () => {
  it("backfills legacy connected components and singleton sources", async () => {
    for (const name of migrationNames.slice(0, 4)) {
      await applyMigration(client, name);
    }

    await client.exec(`
      INSERT INTO workspaces (id, name) VALUES ('ws_primary', 'Primary');
      INSERT INTO sources (
        id, workspace_id, provider, external_id, name, detail, status
      ) VALUES
        ('src_repo_a', 'ws_primary', 'github', 'repo-a', 'acme/a', 'main', 'connected'),
        ('src_doc_a', 'ws_primary', 'confluence', 'doc-a', 'Docs A', 'Acme / A', 'connected'),
        ('src_doc_shared', 'ws_primary', 'confluence', 'doc-shared', 'Shared docs', 'Acme / Shared', 'connected'),
        ('src_repo_b', 'ws_primary', 'github', 'repo-b', 'acme/b', 'main', 'connected'),
        ('src_singleton', 'ws_primary', 'confluence', 'single', 'Standalone docs', 'Acme / Solo', 'connected');
      INSERT INTO source_associations (
        id, workspace_id, repository_source_id, documentation_source_id
      ) VALUES
        ('assoc_1', 'ws_primary', 'src_repo_a', 'src_doc_a'),
        ('assoc_2', 'ws_primary', 'src_repo_a', 'src_doc_shared'),
        ('assoc_3', 'ws_primary', 'src_repo_b', 'src_doc_shared');
    `);

    await applyMigration(client, migrationNames[4]);

    const memberships = await client.query<{
      source_id: string;
      group_id: string;
    }>(`
      SELECT source_id, group_id
      FROM source_group_members
      ORDER BY source_id
    `);
    expect(memberships.rows).toHaveLength(5);
    const groupBySource = new Map(
      memberships.rows.map((membership) => [
        membership.source_id,
        membership.group_id,
      ]),
    );
    const connectedGroup = groupBySource.get("src_repo_a");
    expect(connectedGroup).toBeTruthy();
    expect(groupBySource.get("src_doc_a")).toBe(connectedGroup);
    expect(groupBySource.get("src_doc_shared")).toBe(connectedGroup);
    expect(groupBySource.get("src_repo_b")).toBe(connectedGroup);
    expect(groupBySource.get("src_singleton")).not.toBe(connectedGroup);
    expect(new Set(groupBySource.values()).size).toBe(2);

    const legacyRows = await client.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM source_associations",
    );
    expect(legacyRows.rows[0]?.count).toBe(3);
  });
});
