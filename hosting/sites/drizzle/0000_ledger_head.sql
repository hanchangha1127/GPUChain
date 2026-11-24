CREATE TABLE `ledger_head` (
	`id` integer PRIMARY KEY NOT NULL,
	`tip` text NOT NULL,
	`checkpoint` text NOT NULL
);
