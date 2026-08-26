CREATE TABLE "semantic_analysis_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"changed_node_id" text,
	"analyzer_version" text NOT NULL,
	"analyzer_name" text,
	"model" text,
	"status" text NOT NULL,
	"input_candidate_count" integer NOT NULL,
	"output_decision_count" integer NOT NULL,
	"accepted_decision_count" integer NOT NULL,
	"rejected_decision_count" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"estimated_cost_micros" integer,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "provenance" text DEFAULT 'LEGACY' NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "analyzer_version" text DEFAULT 'deterministic-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "provenance" text DEFAULT 'LEGACY' NOT NULL;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "analyzer_version" text DEFAULT 'deterministic-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "semantic_analysis_attempts" ADD CONSTRAINT "semantic_analysis_attempts_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_analysis_attempts" ADD CONSTRAINT "semantic_analysis_attempts_changed_node_id_graph_nodes_id_fk" FOREIGN KEY ("changed_node_id") REFERENCES "public"."graph_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_semantic_attempts_run_created" ON "semantic_analysis_attempts" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_semantic_attempts_changed_node" ON "semantic_analysis_attempts" USING btree ("changed_node_id");