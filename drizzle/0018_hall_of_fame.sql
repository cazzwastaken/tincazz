CREATE TABLE `guild_hall_exempt_channels` (
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `channel_id`)
);
--> statement-breakpoint
CREATE TABLE `hall_of_fame_entries` (
	`guild_id` text NOT NULL,
	`message_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`author_id` text NOT NULL,
	`hall_channel_id` text NOT NULL,
	`hall_message_id` text,
	`status` text DEFAULT 'publishing' NOT NULL,
	`peak_count` integer DEFAULT 0 NOT NULL,
	`last_rendered_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `message_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hall_of_fame_entries_hall_message_id_unique` ON `hall_of_fame_entries` (`hall_message_id`);--> statement-breakpoint
CREATE INDEX `hall_entries_channel_idx` ON `hall_of_fame_entries` (`channel_id`);--> statement-breakpoint
CREATE INDEX `hall_entries_hall_channel_idx` ON `hall_of_fame_entries` (`hall_channel_id`);--> statement-breakpoint
CREATE INDEX `hall_entries_status_created_idx` ON `hall_of_fame_entries` (`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `guild_settings` ADD `hall_channel_id` text;--> statement-breakpoint
ALTER TABLE `guild_settings` ADD `hall_threshold` integer DEFAULT 5 NOT NULL;