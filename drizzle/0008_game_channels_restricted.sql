ALTER TABLE `guild_settings` ADD `game_channels_restricted` integer DEFAULT false NOT NULL;
--> statement-breakpoint
INSERT INTO `guild_settings` (`guild_id`, `game_channels_restricted`, `updated_at`)
SELECT `guild_id`, 1, MIN(`created_at`)
FROM `guild_game_channels`
GROUP BY `guild_id`
ON CONFLICT (`guild_id`) DO UPDATE SET `game_channels_restricted` = 1;