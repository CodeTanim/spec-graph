import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpecGraphDb } from "../db";
import * as schema from "../db/schema";
import {
  artifacts,
  graphNodes,
  githubInstallations,
  relationships,
  sources,
} from "../db/schema";
import { syncGitHubSource } from "../lib/github/ingestion";
import type { GitHubSourceProvider } from "../lib/providers/source-provider";
import { ensureWorkspaceForUser } from "../lib/server/workspace-provisioning";

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

describe("GitHub graph ingestion", () => {
  it("removes stale relationships when a reference disappears", async () => {
    const context = await ensureWorkspaceForUser(
      {
        id: "github-ingestion-user",
        email: "ingestion@example.com",
        displayName: "Ingestion Tester",
        fullName: "Ingestion Tester",
      },
      db,
    );
    const now = new Date().toISOString();
    await db.insert(githubInstallations).values({
      id: "installation-ingestion",
      workspaceId: context.workspace.id,
      externalInstallationId: "1001",
      accountLogin: "acme",
      accountType: "Organization",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sources).values({
      id: "source-ingestion",
      workspaceId: context.workspace.id,
      githubInstallationId: "installation-ingestion",
      provider: "github",
      externalId: "repo-1001",
      name: "acme/refunds",
      detail: "main",
      defaultBranch: "main",
      status: "connected",
      createdAt: now,
      updatedAt: now,
    });

    let revision = "rev-1";
    const contentBySha = new Map([
      ["code-1", "export class RefundService {}\nexport const refundWindow = 30;"],
      ["doc-1", "# Refunds\n\n[Implementation](../src/refunds.ts)"],
      ["code-2", "export const refundWindow = 45;"],
      ["doc-2", "# Refunds\n\nThis guide no longer names an implementation file."],
    ]);
    const provider: GitHubSourceProvider = {
      provider: "github",
      exchangeOAuthCode: async () => "unused",
      listUserRepositories: async () => [],
      branchRevision: async () => revision,
      repositoryTree: async () => ({
        truncated: false,
        token: "token",
        entries: [
          {
            path: "src/refunds.ts",
            mode: "100644",
            type: "blob",
            sha: revision === "rev-1" ? "code-1" : "code-2",
            size: 40,
          },
          {
            path: "docs/refunds.md",
            mode: "100644",
            type: "blob",
            sha: revision === "rev-1" ? "doc-1" : "doc-2",
            size: 80,
          },
        ],
      }),
      blob: async (_fullName, sha) => contentBySha.get(sha) || "",
      pullRequest: async () => {
        throw new Error("not used");
      },
    };

    await syncGitHubSource(
      context.workspace.id,
      "source-ingestion",
      provider,
      db,
    );
    expect(
      (await db.select().from(relationships)).filter(
        (relationship) => relationship.type === "links",
      ),
    ).toHaveLength(1);
    expect(await db.select().from(graphNodes)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stableKey: "entity:identifier:refundservice",
        kind: "symbol",
        name: "RefundService",
      }),
    ]));

    revision = "rev-2";
    await syncGitHubSource(
      context.workspace.id,
      "source-ingestion",
      provider,
      db,
    );
    expect(
      (await db.select().from(relationships)).filter(
        (relationship) => relationship.type === "links",
      ),
    ).toHaveLength(0);
    expect(
      (await db.select().from(graphNodes)).some(
        (node) => node.stableKey === "entity:identifier:refundservice",
      ),
    ).toBe(false);
    expect(await db.select().from(artifacts)).toHaveLength(2);
  });
});
