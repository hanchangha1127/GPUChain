CREATE TABLE `sale_delivery` (
	`sequence` integer PRIMARY KEY NOT NULL,
	`payment_id` text NOT NULL,
	`order_id` text NOT NULL,
	`intent` text,
	`confirmation` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sale_delivery_payment_id_unique` ON `sale_delivery` (`payment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sale_delivery_order_id_unique` ON `sale_delivery` (`order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sale_single_pending` ON `sale_delivery` ((1)) WHERE confirmation IS NULL;--> statement-breakpoint
CREATE TABLE `sale_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`chain_id` integer NOT NULL,
	`payer` text NOT NULL,
	`recipient` text NOT NULL,
	`amount_micro` integer NOT NULL,
	`intent` text NOT NULL,
	`client_key` text NOT NULL,
	`created_ms` integer NOT NULL,
	`expires_ms` integer NOT NULL,
	`start_block` text NOT NULL,
	`cursor_block` text NOT NULL,
	`scan_after` integer NOT NULL,
	`state` text NOT NULL,
	`payment` text,
	`tx_hash` text,
	`event_id` text,
	`review` text,
	`late_hash` text,
	`delivery_sequence` integer,
	`ledger_height` integer,
	`ledger_tip` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sale_unique_tx` ON `sale_orders` (`chain_id`,`tx_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `sale_unique_event` ON `sale_orders` (`event_id`);--> statement-breakpoint
CREATE INDEX `sale_scan_queue` ON `sale_orders` (`state`,`scan_after`);--> statement-breakpoint
CREATE INDEX `sale_buyer` ON `sale_orders` (`chain_id`,`payer`,`created_ms`);--> statement-breakpoint
CREATE INDEX `sale_client` ON `sale_orders` (`client_key`,`created_ms`);