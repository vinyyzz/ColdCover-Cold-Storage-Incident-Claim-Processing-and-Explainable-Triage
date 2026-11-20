CREATE TABLE `batch_policy_schedules` (
	`batch_id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`assigned_at` text NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `policy_case_packets` (
	`id` text PRIMARY KEY NOT NULL,
	`prepared_at` text NOT NULL,
	`policy_id` text NOT NULL,
	`title` text NOT NULL,
	`request_hash` text NOT NULL,
	`packet_hash` text NOT NULL,
	`snapshot_json` text NOT NULL,
	CONSTRAINT "policy_case_hashes" CHECK(length("policy_case_packets"."request_hash") = 64 AND length("policy_case_packets"."packet_hash") = 64)
);
--> statement-breakpoint
CREATE INDEX `policy_case_prepared_idx` ON `policy_case_packets` (`prepared_at`,`id`);--> statement-breakpoint
CREATE TABLE `policy_case_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`recorded_at` text NOT NULL,
	`revision` integer NOT NULL,
	`decision` text NOT NULL,
	`reviewer` text NOT NULL,
	`comment` text NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `policy_case_packets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_case_review_revision_idx` ON `policy_case_reviews` (`case_id`,`revision`);