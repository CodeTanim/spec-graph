CREATE TABLE "artifact_analysis_cursors" (
	"artifact_id" text PRIMARY KEY NOT NULL,
	"revision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifact_analysis_cursors" ADD CONSTRAINT "artifact_analysis_cursors_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;