CREATE TABLE "source_group_members" (
	"workspace_id" text NOT NULL,
	"group_id" text NOT NULL,
	"source_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_group_members_group_id_source_id_pk" PRIMARY KEY("group_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "source_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_groups_workspace_id" ON "source_groups" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sources_workspace_id" ON "sources" USING btree ("workspace_id","id");--> statement-breakpoint
ALTER TABLE "source_group_members" ADD CONSTRAINT "source_group_members_workspace_group_fk" FOREIGN KEY ("workspace_id","group_id") REFERENCES "public"."source_groups"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_group_members" ADD CONSTRAINT "source_group_members_workspace_source_fk" FOREIGN KEY ("workspace_id","source_id") REFERENCES "public"."sources"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_groups" ADD CONSTRAINT "source_groups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_group_members_source" ON "source_group_members" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "idx_source_group_members_workspace_group" ON "source_group_members" USING btree ("workspace_id","group_id");--> statement-breakpoint
CREATE INDEX "idx_source_groups_workspace" ON "source_groups" USING btree ("workspace_id");--> statement-breakpoint
WITH RECURSIVE "legacy_edges"("workspace_id", "source_id", "peer_id") AS (
	SELECT
		"association"."workspace_id",
		"association"."repository_source_id",
		"association"."documentation_source_id"
	FROM "source_associations" AS "association"
	INNER JOIN "sources" AS "repository"
		ON "repository"."id" = "association"."repository_source_id"
		AND "repository"."workspace_id" = "association"."workspace_id"
	INNER JOIN "sources" AS "documentation"
		ON "documentation"."id" = "association"."documentation_source_id"
		AND "documentation"."workspace_id" = "association"."workspace_id"
	UNION
	SELECT
		"association"."workspace_id",
		"association"."documentation_source_id",
		"association"."repository_source_id"
	FROM "source_associations" AS "association"
	INNER JOIN "sources" AS "repository"
		ON "repository"."id" = "association"."repository_source_id"
		AND "repository"."workspace_id" = "association"."workspace_id"
	INNER JOIN "sources" AS "documentation"
		ON "documentation"."id" = "association"."documentation_source_id"
		AND "documentation"."workspace_id" = "association"."workspace_id"
), "reachable"("workspace_id", "root_source_id", "source_id") AS (
	SELECT "workspace_id", "id", "id" FROM "sources"
	UNION
	SELECT
		"reachable"."workspace_id",
		"reachable"."root_source_id",
		"legacy_edges"."peer_id"
	FROM "reachable"
	INNER JOIN "legacy_edges"
		ON "legacy_edges"."workspace_id" = "reachable"."workspace_id"
		AND "legacy_edges"."source_id" = "reachable"."source_id"
), "components" AS (
	SELECT
		"workspace_id",
		"source_id",
		MIN("root_source_id") AS "component_source_id"
	FROM "reachable"
	GROUP BY "workspace_id", "source_id"
)
INSERT INTO "source_groups" ("id", "workspace_id", "created_at", "updated_at")
SELECT
	'group_legacy_' || MD5("components"."workspace_id" || ':' || "components"."component_source_id"),
	"components"."workspace_id",
	MIN("sources"."created_at"),
	MAX("sources"."updated_at")
FROM "components"
INNER JOIN "sources" ON "sources"."id" = "components"."source_id"
GROUP BY "components"."workspace_id", "components"."component_source_id"
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
WITH RECURSIVE "legacy_edges"("workspace_id", "source_id", "peer_id") AS (
	SELECT
		"association"."workspace_id",
		"association"."repository_source_id",
		"association"."documentation_source_id"
	FROM "source_associations" AS "association"
	INNER JOIN "sources" AS "repository"
		ON "repository"."id" = "association"."repository_source_id"
		AND "repository"."workspace_id" = "association"."workspace_id"
	INNER JOIN "sources" AS "documentation"
		ON "documentation"."id" = "association"."documentation_source_id"
		AND "documentation"."workspace_id" = "association"."workspace_id"
	UNION
	SELECT
		"association"."workspace_id",
		"association"."documentation_source_id",
		"association"."repository_source_id"
	FROM "source_associations" AS "association"
	INNER JOIN "sources" AS "repository"
		ON "repository"."id" = "association"."repository_source_id"
		AND "repository"."workspace_id" = "association"."workspace_id"
	INNER JOIN "sources" AS "documentation"
		ON "documentation"."id" = "association"."documentation_source_id"
		AND "documentation"."workspace_id" = "association"."workspace_id"
), "reachable"("workspace_id", "root_source_id", "source_id") AS (
	SELECT "workspace_id", "id", "id" FROM "sources"
	UNION
	SELECT
		"reachable"."workspace_id",
		"reachable"."root_source_id",
		"legacy_edges"."peer_id"
	FROM "reachable"
	INNER JOIN "legacy_edges"
		ON "legacy_edges"."workspace_id" = "reachable"."workspace_id"
		AND "legacy_edges"."source_id" = "reachable"."source_id"
), "components" AS (
	SELECT
		"workspace_id",
		"source_id",
		MIN("root_source_id") AS "component_source_id"
	FROM "reachable"
	GROUP BY "workspace_id", "source_id"
)
INSERT INTO "source_group_members" ("workspace_id", "group_id", "source_id", "created_at")
SELECT
	"components"."workspace_id",
	'group_legacy_' || MD5("components"."workspace_id" || ':' || "components"."component_source_id"),
	"components"."source_id",
	"sources"."created_at"
FROM "components"
INNER JOIN "sources" ON "sources"."id" = "components"."source_id"
ON CONFLICT ("source_id") DO NOTHING;
