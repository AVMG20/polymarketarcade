CREATE TABLE `gridworks_plot` (
	`player_id` text PRIMARY KEY NOT NULL,
	`seed` integer NOT NULL,
	`entities` text DEFAULT '[]' NOT NULL,
	`chunks` text DEFAULT '[]' NOT NULL,
	`stock` text DEFAULT '{}' NOT NULL,
	`research_done` text DEFAULT '[]' NOT NULL,
	`research_queue` text DEFAULT '[]' NOT NULL,
	`research_progress` text DEFAULT '{}' NOT NULL,
	`mine` text DEFAULT '{"tokens":0,"at":0}' NOT NULL,
	`layout_version` integer DEFAULT 1 NOT NULL,
	`goals` text DEFAULT '[]' NOT NULL,
	`mined` integer DEFAULT 0 NOT NULL,
	`last_settled_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
