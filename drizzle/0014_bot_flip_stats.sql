ALTER TABLE `player_stats` ADD `bot_flip_wagered` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `player_stats` ADD `bot_flip_won` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `player_stats` SET
  `bot_flip_wagered` = (SELECT COALESCE(SUM(`bet`), 0) FROM `flips` WHERE `flips`.`mode` = 'bot' AND `flips`.`guild_id` = `player_stats`.`guild_id` AND `flips`.`challenger_id` = `player_stats`.`user_id`),
  `bot_flip_won` = (SELECT COALESCE(SUM(2 * `bet` - `rake`), 0) FROM `flips` WHERE `flips`.`mode` = 'bot' AND `flips`.`guild_id` = `player_stats`.`guild_id` AND `flips`.`challenger_id` = `player_stats`.`user_id` AND `flips`.`winner_id` = `flips`.`challenger_id`);
