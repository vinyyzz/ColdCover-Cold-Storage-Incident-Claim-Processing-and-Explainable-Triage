CREATE TABLE `document_corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`revision` integer NOT NULL,
	`previous_correction_id` text,
	`analysis_id` text NOT NULL,
	`original_fingerprint` text NOT NULL,
	`request_json` text NOT NULL,
	`extraction_json` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`previous_correction_id`) REFERENCES `document_corrections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`analysis_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "document_correction_chain" CHECK(("document_corrections"."revision" = 1 AND "document_corrections"."previous_correction_id" IS NULL) OR ("document_corrections"."revision" > 1 AND "document_corrections"."previous_correction_id" IS NOT NULL)),
	CONSTRAINT "document_correction_actor" CHECK("document_corrections"."actor" = 'storage_operator')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_correction_revision_idx` ON `document_corrections` (`document_id`,`revision`);