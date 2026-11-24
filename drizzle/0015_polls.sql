CREATE TABLE `poll_votes` (
	`guild_id` text NOT NULL,
	`poll_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`option_index` integer NOT NULL,
	`voted_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `poll_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `polls` (
	`id` integer NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text,
	`creation_id` text NOT NULL,
	`host_id` text NOT NULL,
	`question` text NOT NULL,
	`options` text NOT NULL,
	`yes_no` integer DEFAULT false NOT NULL,
	`anonymous` integer DEFAULT false NOT NULL,
	`ends_at` integer NOT NULL,
	`status` text DEFAULT 'publishing' NOT NULL,
	`closed_by` text,
	`closed_at` integer,
	`next_sync_at` integer,
	`access_failures` integer DEFAULT 0 NOT NULL,
	`last_rendered_hash` text,
	`last_recount_at` integer,
	PRIMARY KEY(`guild_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `polls_message_id_unique` ON `polls` (`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `polls_creation_id_unique` ON `polls` (`creation_id`);--> statement-breakpoint
CREATE INDEX `polls_next_sync_idx` ON `polls` (`next_sync_at`);--> statement-breakpoint
CREATE INDEX `polls_host_status_idx` ON `polls` (`guild_id`,`host_id`,`status`);