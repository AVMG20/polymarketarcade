CREATE TABLE `polytown_buildings` (
	`id` text PRIMARY KEY NOT NULL,
	`player_id` text NOT NULL,
	`plot_id` text NOT NULL,
	`type` text NOT NULL,
	`tile_x` integer NOT NULL,
	`tile_y` integer NOT NULL,
	`rotation` integer DEFAULT 0 NOT NULL,
	`level` integer DEFAULT 0 NOT NULL,
	`upgrading_to` integer,
	`completes_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plot_id`) REFERENCES `polytown_plots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `polytown_buildings_player_idx` ON `polytown_buildings` (`player_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `polytown_buildings_tile_unique` ON `polytown_buildings` (`plot_id`,`tile_x`,`tile_y`);--> statement-breakpoint
CREATE TABLE `polytown_contract_days` (
	`id` text PRIMARY KEY NOT NULL,
	`player_id` text NOT NULL,
	`day` text NOT NULL,
	`bonus` text NOT NULL,
	`bonus_claimed` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `polytown_contract_days_player_day_unique` ON `polytown_contract_days` (`player_id`,`day`);--> statement-breakpoint
CREATE TABLE `polytown_contracts` (
	`id` text PRIMARY KEY NOT NULL,
	`player_id` text NOT NULL,
	`day` text NOT NULL,
	`slot` integer NOT NULL,
	`resource` text NOT NULL,
	`quantity` integer NOT NULL,
	`reward` real NOT NULL,
	`delivered` integer DEFAULT false NOT NULL,
	`delivered_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `polytown_contracts_player_day_slot_unique` ON `polytown_contracts` (`player_id`,`day`,`slot`);--> statement-breakpoint
CREATE TABLE `polytown_events` (
	`id` text PRIMARY KEY NOT NULL,
	`player_id` text NOT NULL,
	`kind` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `polytown_events_player_created_idx` ON `polytown_events` (`player_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `polytown_gem_spends` (
	`idempotency_key` text PRIMARY KEY NOT NULL,
	`player_id` text NOT NULL,
	`spend_id` text NOT NULL,
	`perk` text NOT NULL,
	`gems` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `polytown_gem_spends_player_idx` ON `polytown_gem_spends` (`player_id`);--> statement-breakpoint
CREATE TABLE `polytown_inventory` (
	`player_id` text NOT NULL,
	`resource` text NOT NULL,
	`amount` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`player_id`, `resource`),
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `polytown_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`player_id` text NOT NULL,
	`resource` text NOT NULL,
	`side` text NOT NULL,
	`price` real NOT NULL,
	`quantity` integer NOT NULL,
	`filled` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `polytown_orders_book_idx` ON `polytown_orders` (`resource`,`status`,`side`,`price`);--> statement-breakpoint
CREATE INDEX `polytown_orders_player_idx` ON `polytown_orders` (`player_id`,`status`);--> statement-breakpoint
CREATE TABLE `polytown_plots` (
	`id` text PRIMARY KEY NOT NULL,
	`player_id` text NOT NULL,
	`x` integer NOT NULL,
	`y` integer NOT NULL,
	`list_price` real,
	`paid_price` real DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `polytown_plots_player_idx` ON `polytown_plots` (`player_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `polytown_plots_xy_unique` ON `polytown_plots` (`x`,`y`);--> statement-breakpoint
CREATE TABLE `polytown_production` (
	`id` text PRIMARY KEY NOT NULL,
	`player_id` text NOT NULL,
	`resource` text NOT NULL,
	`amount` integer NOT NULL,
	`from_at` integer NOT NULL,
	`to_at` integer NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `polytown_production_player_to_idx` ON `polytown_production` (`player_id`,`to_at`);--> statement-breakpoint
CREATE TABLE `polytown_redesign_drafts` (
	`player_id` text PRIMARY KEY NOT NULL,
	`draft` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `polytown_state` (
	`player_id` text PRIMARY KEY NOT NULL,
	`coins_cents` integer DEFAULT 0 NOT NULL,
	`happiness` integer DEFAULT 50 NOT NULL,
	`tick_progress_ms` integer DEFAULT 0 NOT NULL,
	`last_settled_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`plots_bought` integer DEFAULT 1 NOT NULL,
	`last_plot_bought_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`milestones_claimed` text DEFAULT '[]' NOT NULL,
	`coins_earned` real DEFAULT 0 NOT NULL,
	`produced` text DEFAULT '{}' NOT NULL,
	`builders` integer DEFAULT 3 NOT NULL,
	`carry` text DEFAULT '{}' NOT NULL,
	`monument_credit` text DEFAULT '{}' NOT NULL,
	`build_boost_until` integer,
	`production_boost_until` integer,
	`temp_builder_until` integer,
	`market_boost_until` integer,
	`market_boost_bonus_left` real DEFAULT 0 NOT NULL,
	`boosters` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `polytown_storage` (
	`id` text PRIMARY KEY NOT NULL,
	`player_id` text NOT NULL,
	`type` text NOT NULL,
	`level` integer NOT NULL,
	`upgrading_to` integer,
	`remaining_ms` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`stored_at` integer NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `polytown_storage_player_idx` ON `polytown_storage` (`player_id`);--> statement-breakpoint
CREATE TABLE `polytown_streak` (
	`player_id` text PRIMARY KEY NOT NULL,
	`step` integer DEFAULT 0 NOT NULL,
	`last_day` text,
	`claimed` integer DEFAULT 0 NOT NULL,
	`cycle` integer DEFAULT 0 NOT NULL,
	`locked` text DEFAULT '{}' NOT NULL,
	`lucky` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `polytown_trades` (
	`id` text PRIMARY KEY NOT NULL,
	`resource` text NOT NULL,
	`buyer_id` text,
	`seller_id` text,
	`taker_id` text,
	`price` real NOT NULL,
	`quantity` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`buyer_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`seller_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`taker_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `polytown_trades_resource_created_idx` ON `polytown_trades` (`resource`,`created_at`);--> statement-breakpoint
CREATE INDEX `polytown_trades_buyer_idx` ON `polytown_trades` (`buyer_id`);--> statement-breakpoint
CREATE INDEX `polytown_trades_seller_idx` ON `polytown_trades` (`seller_id`);--> statement-breakpoint
CREATE INDEX `polytown_trades_taker_idx` ON `polytown_trades` (`taker_id`);