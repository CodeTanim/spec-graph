ALTER TABLE "change_events" ADD COLUMN "changed_artifacts_json" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "evidence_start_line" integer;