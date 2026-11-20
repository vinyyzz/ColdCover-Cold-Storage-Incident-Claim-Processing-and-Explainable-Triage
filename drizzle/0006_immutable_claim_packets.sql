CREATE TABLE `claim_packets` (
	`claim_id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`request_json` text NOT NULL,
	`analysis_id` text NOT NULL,
	`prepared_at` text NOT NULL,
	`packet_json` text NOT NULL,
	`packet_hash` text NOT NULL,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`analysis_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "claim_packet_hash" CHECK(length("claim_packets"."packet_hash") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_packets_request_id_unique` ON `claim_packets` (`request_id`);