CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`at` text NOT NULL,
	`detail` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_entity_idx` ON `audit_log` (`entity`,`entity_id`);--> statement-breakpoint
CREATE TABLE `batches` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_code` text NOT NULL,
	`owner_name` text NOT NULL,
	`chamber_id` text NOT NULL,
	`quantity_kg` real NOT NULL,
	`recorded_value_inr` real,
	`entered_at` text NOT NULL,
	`exited_at` text,
	FOREIGN KEY (`chamber_id`) REFERENCES `chambers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "batch_positive_quantity" CHECK("batches"."quantity_kg" > 0),
	CONSTRAINT "batch_nonnegative_value" CHECK("batches"."recorded_value_inr" IS NULL OR "batches"."recorded_value_inr" >= 0),
	CONSTRAINT "batch_storage_order" CHECK("batches"."exited_at" IS NULL OR julianday("batches"."exited_at") >= julianday("batches"."entered_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `batches_batch_code_unique` ON `batches` (`batch_code`);--> statement-breakpoint
CREATE INDEX `batch_chamber_entry_idx` ON `batches` (`chamber_id`,`entered_at`);--> statement-breakpoint
CREATE TABLE `chambers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`commodity` text NOT NULL,
	`normal_min_c` real NOT NULL,
	`normal_max_c` real NOT NULL,
	CONSTRAINT "chamber_temperature_range" CHECK("chambers"."normal_min_c" <= "chambers"."normal_max_c"),
	CONSTRAINT "chamber_commodity" CHECK("chambers"."commodity" = 'potatoes')
);
--> statement-breakpoint
CREATE TABLE `claims` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`readiness` text NOT NULL,
	`priority` text NOT NULL,
	`triage_reasons_json` text NOT NULL,
	`exposure_value_inr` real NOT NULL,
	`summary_json` text NOT NULL,
	`missing_evidence_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "claim_readiness" CHECK("claims"."readiness" IN ('Needs more evidence','Ready for initial review')),
	CONSTRAINT "claim_priority" CHECK("claims"."priority" IN ('Specialist review required','High priority','Standard priority')),
	CONSTRAINT "claim_nonnegative_exposure" CHECK("claims"."exposure_value_inr" >= 0)
);
--> statement-breakpoint
CREATE INDEX `claim_incident_idx` ON `claims` (`incident_id`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`doc_type` text NOT NULL,
	`filename` text NOT NULL,
	`raw_text` text NOT NULL,
	`uploaded_at` text NOT NULL,
	`extraction_json` text,
	`extraction_source` text,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "document_type" CHECK("documents"."doc_type" IN ('maintenance_report','stock_inspection_report','invoice','other')),
	CONSTRAINT "document_extraction_source" CHECK("documents"."extraction_source" IS NULL OR "documents"."extraction_source" IN ('ai','fallback'))
);
--> statement-breakpoint
CREATE INDEX `document_incident_idx` ON `documents` (`incident_id`);--> statement-breakpoint
CREATE TABLE `equipment` (
	`id` text PRIMARY KEY NOT NULL,
	`chamber_id` text NOT NULL,
	`equipment_code` text NOT NULL,
	`description` text NOT NULL,
	FOREIGN KEY (`chamber_id`) REFERENCES `chambers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `equipment_equipment_code_unique` ON `equipment` (`equipment_code`);--> statement-breakpoint
CREATE TABLE `incident_events` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`event_type` text NOT NULL,
	`description` text NOT NULL,
	`source_type` text NOT NULL,
	`source_ref` text NOT NULL,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "event_type" CHECK("incident_events"."event_type" IN ('abnormal_start','abnormal_end','equipment_fault','repair','restart','inspection','document_uploaded','data_gap'))
);
--> statement-breakpoint
CREATE INDEX `incident_event_time_idx` ON `incident_events` (`incident_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`chamber_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`abnormal_start` text,
	`abnormal_end` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`chamber_id`) REFERENCES `chambers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "incident_status" CHECK("incidents"."status" IN ('draft','claim_prepared','submitted','under_review','decided')),
	CONSTRAINT "incident_interval_order" CHECK("incidents"."abnormal_end" IS NULL OR ("incidents"."abnormal_start" IS NOT NULL AND julianday("incidents"."abnormal_end") >= julianday("incidents"."abnormal_start")))
);
--> statement-breakpoint
CREATE INDEX `incident_chamber_idx` ON `incidents` (`chamber_id`);--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`machinery_breakdown_cover_required` integer NOT NULL,
	`records_required_text` text NOT NULL,
	`notes` text NOT NULL,
	`wording` text NOT NULL,
	`demonstration_label` text NOT NULL,
	CONSTRAINT "policy_cover_boolean" CHECK("policies"."machinery_breakdown_cover_required" IN (0,1))
);
--> statement-breakpoint
CREATE TABLE `review_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`reviewer_name` text NOT NULL,
	`status` text NOT NULL,
	`comment` text NOT NULL,
	`decided_at` text NOT NULL,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "review_status" CHECK("review_decisions"."status" IN ('approved_for_assessment','needs_more_info','referred_to_specialist','closed'))
);
--> statement-breakpoint
CREATE INDEX `review_claim_idx` ON `review_decisions` (`claim_id`);--> statement-breakpoint
CREATE TABLE `scenarios` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`category` text NOT NULL,
	`expected_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `temperature_readings` (
	`id` text PRIMARY KEY NOT NULL,
	`chamber_id` text NOT NULL,
	`scenario_id` text,
	`recorded_at` text NOT NULL,
	`temperature_c` real NOT NULL,
	FOREIGN KEY (`chamber_id`) REFERENCES `chambers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scenario_id`) REFERENCES `scenarios`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `temperature_chamber_timestamp_idx` ON `temperature_readings` (`chamber_id`,`recorded_at`);--> statement-breakpoint
CREATE TABLE `thresholds` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`abnormal_above_c` real DEFAULT 5 NOT NULL,
	`min_abnormal_minutes` integer DEFAULT 30 NOT NULL,
	`max_gap_minutes` integer DEFAULT 30 NOT NULL,
	`expected_interval_minutes` integer DEFAULT 10 NOT NULL,
	`high_exposure_threshold_inr` real DEFAULT 150000 NOT NULL,
	CONSTRAINT "threshold_singleton" CHECK("thresholds"."id" = 1),
	CONSTRAINT "threshold_positive_durations" CHECK("thresholds"."min_abnormal_minutes" > 0 AND "thresholds"."max_gap_minutes" > 0 AND "thresholds"."expected_interval_minutes" > 0),
	CONSTRAINT "threshold_nonnegative_exposure" CHECK("thresholds"."high_exposure_threshold_inr" >= 0)
);
