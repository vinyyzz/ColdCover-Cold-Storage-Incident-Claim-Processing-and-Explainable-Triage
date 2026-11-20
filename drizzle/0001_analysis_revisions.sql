CREATE TABLE `analysis_incident_links` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_id` text NOT NULL,
	`interval_id` text NOT NULL,
	`incident_id` text NOT NULL,
	`evidence_fingerprint` text NOT NULL,
	FOREIGN KEY (`analysis_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analysis_interval_idx` ON `analysis_incident_links` (`analysis_id`,`interval_id`);--> statement-breakpoint
CREATE INDEX `analysis_link_incident_idx` ON `analysis_incident_links` (`incident_id`);--> statement-breakpoint
CREATE TABLE `analysis_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`chamber_id` text NOT NULL,
	`revision` integer NOT NULL,
	`source_fingerprint` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`chamber_id`) REFERENCES `chambers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "analysis_positive_revision" CHECK("analysis_runs"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analysis_chamber_revision_idx` ON `analysis_runs` (`chamber_id`,`revision`);