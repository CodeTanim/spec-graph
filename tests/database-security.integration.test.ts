import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const applicationTables = [
  "analysis_runs",
  "artifact_analysis_cursors",
  "artifact_versions",
  "artifacts",
  "change_events",
  "confluence_connections",
  "finding_actions",
  "finding_evidence",
  "findings",
  "github_installations",
  "graph_nodes",
  "provider_connection_sessions",
  "relationships",
  "run_attempts",
  "semantic_analysis_attempts",
  "source_associations",
  "source_group_members",
  "source_groups",
  "sources",
  "users",
  "webhook_deliveries",
  "workspace_members",
  "workspaces",
] as const;

let client: PGlite;

beforeEach(async () => {
  client = new PGlite();
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: "drizzle-postgres" });
});

afterEach(async () => {
  await client.close();
});

describe("database security migrations", () => {
  it("enables row-level security on every application table", async () => {
    const tableNames = applicationTables.map((name) => `'${name}'`).join(", ");
    const result = await client.query<{
      table_name: string;
      rls_enabled: boolean;
    }>(`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname IN (${tableNames})
      ORDER BY c.relname
    `);

    expect(result.rows).toHaveLength(applicationTables.length);
    expect(result.rows.every((table) => table.rls_enabled)).toBe(true);
  });
});
