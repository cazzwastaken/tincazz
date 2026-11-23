CREATE TABLE `giveaways` (
	`id` integer NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	`host_id` text NOT NULL,
	`prize` text NOT NULL,
	`ends_at` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`entry_count` integer,
	`winner_id` text,
	`drawn_at` integer,
	`next_sync_at` integer,
	PRIMARY KEY(`guild_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `giveaways_message_id_unique` ON `giveaways` (`message_id`);--> statement-breakpoint
CREATE INDEX `giveaways_next_sync_idx` ON `giveaways` (`next_sync_at`);--> statement-breakpoint
CREATE INDEX `giveaways_guild_active_idx` ON `giveaways` (`guild_id`,`status`,`ends_at`);