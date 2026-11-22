CREATE TABLE `star_reports` (
	`player_id` text NOT NULL,
	`game` text NOT NULL,
	`stars` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`player_id`, `game`),
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
