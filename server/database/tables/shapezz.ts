import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { players, updatedAt } from '../core'

/**
 * One SHAPEZZ save per player: the shard balance, the workshop levels, the
 * owned weapon per type (rarity and what was paid for it, for the trade-in),
 * run records and the one run that may be in progress. Shards only move
 * through server/utils/shapezz.ts, always in a guarded update.
 */
export const shapezzState = sqliteTable('shapezz_state', {
    playerId: text('player_id').primaryKey().references(() => players.id, { onDelete: 'cascade' }),
    shards: integer('shards').notNull().default(0),
    coreLevel: integer('core_level').notNull().default(0),
    overclockLevel: integer('overclock_level').notNull().default(0),
    armorLevel: integer('armor_level').notNull().default(0),
    thrustersLevel: integer('thrusters_level').notNull().default(0),
    magnetLevel: integer('magnet_level').notNull().default(0),
    killHealLevel: integer('kill_heal_level').notNull().default(0),
    weaponType: text('weapon_type').notNull().default('blaster'),
    // Owned rarity per weapon type (null: not owned) and the price paid for it.
    blasterRarity: text('blaster_rarity').notNull().default('common'),
    blasterPrice: integer('blaster_price').notNull().default(0),
    launcherRarity: text('launcher_rarity'),
    launcherPrice: integer('launcher_price').notNull().default(0),
    shotgunRarity: text('shotgun_rarity'),
    shotgunPrice: integer('shotgun_price').notNull().default(0),
    arcCoilRarity: text('arc_coil_rarity'),
    arcCoilPrice: integer('arc_coil_price').notNull().default(0),
    railgunRarity: text('railgun_rarity'),
    railgunPrice: integer('railgun_price').notNull().default(0),
    runsPlayed: integer('runs_played').notNull().default(0),
    totalShardsEarned: integer('total_shards_earned').notNull().default(0),
    bestSurvivalMs: integer('best_survival_ms').notNull().default(0),
    bestKills: integer('best_kills').notNull().default(0),
    bestCheckpoint: integer('best_checkpoint').notNull().default(0),
    // The run in progress: issued by start-run, settled once by finish-run
    // (the conditional clear of run_id is the guard).
    runId: text('run_id'),
    runStartedAt: integer('run_started_at', { mode: 'timestamp_ms' }),
    runDifficulty: text('run_difficulty'),
    runPower: integer('run_power'),
    updatedAt: updatedAt()
})
