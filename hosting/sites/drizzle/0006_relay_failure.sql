DROP INDEX `relay_payer_nonce`;--> statement-breakpoint
ALTER TABLE `relay_jobs` ADD `failed_no_receipt` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `relay_payer_nonce` ON `relay_jobs` (`payer`,`nonce`) WHERE failed_no_receipt = 0;