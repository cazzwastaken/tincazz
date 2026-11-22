CREATE TABLE `pending_coinflip_challenges` (
	`message_id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`challenger_id` text NOT NULL,
	`opponent_id` text,
	`bet` integer NOT NULL,
	`side` text NOT NULL,
	`expires_at` integer NOT NULL,
	`closed_reason` text
);
