CREATE TABLE `relay_chunks` (
	`job_id` text NOT NULL,
	`direction` integer NOT NULL,
	`part` integer NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `relay_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_chunk_part` ON `relay_chunks` (`job_id`,`direction`,`part`);--> statement-breakpoint
CREATE TABLE `relay_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`payer` text NOT NULL,
	`nonce` integer NOT NULL,
	`phase` text NOT NULL,
	`expires_ms` integer NOT NULL,
	`submit_hash` text NOT NULL,
	`request_meta` text,
	`reply_meta` text,
	`result_hash` text,
	`bytes` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_open_provider` ON `relay_jobs` (`provider`) WHERE phase <> 'done';--> statement-breakpoint
CREATE UNIQUE INDEX `relay_payer_nonce` ON `relay_jobs` (`payer`,`nonce`);--> statement-breakpoint
CREATE INDEX `relay_job_expiry` ON `relay_jobs` (`expires_ms`);--> statement-breakpoint
CREATE TABLE `relay_presence` (
	`provider` text PRIMARY KEY NOT NULL,
	`live_key` text NOT NULL,
	`available` integer NOT NULL,
	`issued_ms` integer NOT NULL,
	`expires_ms` integer NOT NULL,
	`advert` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `relay_presence_expiry` ON `relay_presence` (`expires_ms`);