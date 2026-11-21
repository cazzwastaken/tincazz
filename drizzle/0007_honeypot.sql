ALTER TABLE `guild_settings` ADD `honeypot_channel_id` text;--> statement-breakpoint
ALTER TABLE `guild_settings` ADD `honeypot_message_id` text;--> statement-breakpoint
ALTER TABLE `guild_settings` ADD `honeypot_kicks` integer DEFAULT 0 NOT NULL;