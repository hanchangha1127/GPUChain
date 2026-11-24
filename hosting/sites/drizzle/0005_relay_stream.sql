ALTER TABLE `relay_jobs` ADD `stream_tail` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `relay_jobs` ADD `stream_ack` integer DEFAULT 0 NOT NULL;