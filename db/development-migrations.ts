import initialMigration from "../drizzle/0000_good_sersi.sql?raw";
import githubMigration from "../drizzle/0001_large_devos.sql?raw";
import sourceRevisionMigration from "../drizzle/0002_glorious_red_ghost.sql?raw";
import confluenceMigration from "../drizzle/0003_brief_ronan.sql?raw";

const migrations = [
  { id: "0000_good_sersi", sql: initialMigration },
  { id: "0001_large_devos", sql: githubMigration },
  { id: "0002_glorious_red_ghost", sql: sourceRevisionMigration },
  { id: "0003_brief_ronan", sql: confluenceMigration },
];

let migrationPromise: Promise<void> | null = null;

function statements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function isAlreadyApplied(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("already exists") ||
    message.includes("duplicate column name")
  );
}

async function applyDevelopmentMigrations(binding: D1Database): Promise<void> {
  await binding
    .prepare(
      `CREATE TABLE IF NOT EXISTS specgraph_local_migrations (
        id TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
      )`,
    )
    .run();
  const applied = await binding
    .prepare("SELECT id FROM specgraph_local_migrations")
    .all<{ id: string }>();
  const appliedIds = new Set(applied.results.map((row) => row.id));

  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) continue;
    for (const statement of statements(migration.sql)) {
      try {
        await binding.prepare(statement).run();
      } catch (error) {
        if (!isAlreadyApplied(error)) throw error;
      }
    }
    await binding
      .prepare("INSERT OR IGNORE INTO specgraph_local_migrations (id) VALUES (?)")
      .bind(migration.id)
      .run();
  }
}

export function ensureDevelopmentMigrations(binding: D1Database): Promise<void> {
  migrationPromise ??= applyDevelopmentMigrations(binding);
  return migrationPromise;
}
