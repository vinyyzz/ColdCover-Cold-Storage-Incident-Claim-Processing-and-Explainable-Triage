CREATE TABLE `demo_backups` (
	`id` text PRIMARY KEY NOT NULL,
	`sequence` integer NOT NULL,
	`action` text NOT NULL,
	`created_at` text NOT NULL,
	`schema_fingerprint` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`counts_json` text NOT NULL,
	CONSTRAINT "demo_backup_sequence" CHECK("demo_backups"."sequence" > 0),
	CONSTRAINT "demo_backup_action" CHECK("demo_backups"."action" IN ('reset','restore')),
	CONSTRAINT "demo_backup_hashes" CHECK(length("demo_backups"."schema_fingerprint") = 64 AND length("demo_backups"."snapshot_hash") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `demo_backups_sequence_unique` ON `demo_backups` (`sequence`);--> statement-breakpoint
CREATE TABLE `demo_operations` (
	`request_id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`backup_id` text NOT NULL,
	`restored_from` text,
	`request_json` text NOT NULL,
	`receipt_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`backup_id`) REFERENCES `demo_backups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`restored_from`) REFERENCES `demo_backups`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "demo_operation_kind" CHECK(("demo_operations"."action" = 'reset' AND "demo_operations"."restored_from" IS NULL) OR ("demo_operations"."action" = 'restore' AND "demo_operations"."restored_from" IS NOT NULL))
);
