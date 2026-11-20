CREATE TABLE `ai_result_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`input_fingerprint` text NOT NULL,
	`boundary_version` text NOT NULL,
	`task` text NOT NULL,
	`adapter_revision` text NOT NULL,
	`output_json` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "ai_cache_key_length" CHECK(length("ai_result_cache"."cache_key") = 64 AND length("ai_result_cache"."input_fingerprint") = 64),
	CONSTRAINT "ai_cache_task" CHECK("ai_result_cache"."task" IN ('extraction','summary','questions'))
);
