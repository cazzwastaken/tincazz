CREATE TABLE `pending_screenings` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`)
);
