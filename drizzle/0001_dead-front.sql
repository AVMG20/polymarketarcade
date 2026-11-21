CREATE TABLE `dead_front_profiles` (
	`player_id` text PRIMARY KEY NOT NULL,
	`unlocked_weapons` text DEFAULT '["m1911"]' NOT NULL,
	`weapon_xp` text DEFAULT '{}' NOT NULL,
	`loadout` text DEFAULT '{"startWeapon":"m1911","attachments":{}}' NOT NULL,
	`perk_levels` text DEFAULT '{}' NOT NULL,
	`perk_mods` text DEFAULT '{}' NOT NULL,
	`medals` integer DEFAULT 0 NOT NULL,
	`medals_earned` integer DEFAULT 0 NOT NULL,
	`games_played` integer DEFAULT 0 NOT NULL,
	`best_round` integer DEFAULT 0 NOT NULL,
	`total_kills` integer DEFAULT 0 NOT NULL,
	`eggs_completed` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `dead_front_results` (
	`match_id` text NOT NULL,
	`player_id` text NOT NULL,
	`round` integer NOT NULL,
	`kills` integer NOT NULL,
	`medals` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`match_id`, `player_id`),
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dead_front_results_player_idx` ON `dead_front_results` (`player_id`,`created_at`);