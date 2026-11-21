CREATE TABLE `pirate_cannons` (
	`player_id` text NOT NULL,
	`slot_index` integer NOT NULL,
	`tier_id` text NOT NULL,
	`purchase_price` integer NOT NULL,
	PRIMARY KEY(`player_id`, `slot_index`),
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pirate_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`player_id` text NOT NULL,
	`loot` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`power` integer NOT NULL,
	`difficulty` integer NOT NULL,
	`survived` integer NOT NULL,
	`completed` integer NOT NULL,
	`reason` text NOT NULL,
	`kills` integer NOT NULL,
	`shots_fired` integer NOT NULL,
	`skin_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pirate_runs_player_idx` ON `pirate_runs` (`player_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `pirate_state` (
	`player_id` text PRIMARY KEY NOT NULL,
	`doubloons` integer DEFAULT 0 NOT NULL,
	`total_earned` integer DEFAULT 0 NOT NULL,
	`hull_level` integer DEFAULT 1 NOT NULL,
	`speed_level` integer DEFAULT 1 NOT NULL,
	`defense_level` integer DEFAULT 1 NOT NULL,
	`ammo_capacity_level` integer DEFAULT 1 NOT NULL,
	`regen_level` integer DEFAULT 1 NOT NULL,
	`cannon_slots` integer DEFAULT 1 NOT NULL,
	`marque_level` integer DEFAULT 0 NOT NULL,
	`owned_skin_ids` text DEFAULT '["starter"]' NOT NULL,
	`equipped_skin_id` text DEFAULT 'starter' NOT NULL,
	`owned_ability_ids` text DEFAULT '["bomb"]' NOT NULL,
	`equipped_ability_id` text DEFAULT 'bomb' NOT NULL,
	`ability_levels` text DEFAULT '{}' NOT NULL,
	`runs_played` integer DEFAULT 0 NOT NULL,
	`best_survival_ms` integer DEFAULT 0 NOT NULL,
	`highest_completed_difficulty` integer DEFAULT -1 NOT NULL,
	`best_completed_loot` integer DEFAULT 0 NOT NULL,
	`best_completed_power` integer DEFAULT 0 NOT NULL,
	`best_completed_skin_id` text DEFAULT 'starter' NOT NULL,
	`run_id` text,
	`run_started_at` integer,
	`run_power` integer,
	`run_difficulty` integer,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
