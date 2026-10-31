CREATE TABLE `guild_game_channels` (
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `channel_id`)
);
