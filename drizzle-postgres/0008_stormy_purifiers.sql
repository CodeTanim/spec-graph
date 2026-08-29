ALTER TABLE "findings" ADD COLUMN "impact_fingerprint" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_findings_impact_fingerprint" ON "findings" USING btree ("impact_fingerprint");