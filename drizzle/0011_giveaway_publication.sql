PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_giveaways` (
	`id` integer NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text,
	`creation_id` text,
	`duration_ms` integer,
	`host_id` text NOT NULL,
	`prize` text NOT NULL,
	`ends_at` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`access_failures` integer DEFAULT 0 NOT NULL,
	`entry_count` integer,
	`winner_id` text,
	`drawn_at` integer,
	`next_sync_at` integer,
	PRIMARY KEY(`guild_id`, `id`)
);
--> statement-breakpoint
INSERT INTO `__new_giveaways` ("id", "guild_id", "channel_id", "message_id", "host_id", "prize", "ends_at", "status", "entry_count", "winner_id", "drawn_at", "next_sync_at") SELECT "id", "guild_id", "channel_id", "message_id", "host_id", "prize", "ends_at", "status", "entry_count", "winner_id", "drawn_at", "next_sync_at" FROM `giveaways`;--> statement-breakpoint
DROP TABLE `giveaways`;--> statement-breakpoint
ALTER TABLE `__new_giveaways` RENAME TO `giveaways`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `giveaways_message_id_unique` ON `giveaways` (`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `giveaways_creation_id_unique` ON `giveaways` (`creation_id`);--> statement-breakpoint
CREATE INDEX `giveaways_next_sync_idx` ON `giveaways` (`next_sync_at`);--> statement-breakpoint
CREATE INDEX `giveaways_guild_active_idx` ON `giveaways` (`guild_id`,`status`,`ends_at`);
