import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { createdAt, players } from '../core'

/**
 * Pirate Raid progression, one row per captain. Doubloons are the game's own
 * currency: voyages pay them and the armory spends them (see
 * shared/pirate-raid/economy.ts). Levels start at 1; the starter swivel gun,
 * powder keg and brigantine are free and always owned.
 */
export const pirateState = sqliteTable('pirate_state', {
    playerId: text('player_id').primaryKey().references(() => players.id, { onDelete: 'cascade' }),
    doubloons: integer('doubloons').notNull().default(0),
    totalEarned: integer('total_earned').notNull().default(0),
    hullLevel: integer('hull_level').notNull().default(1),
    speedLevel: integer('speed_level').notNull().default(1),
    defenseLevel: integer('defense_level').notNull().default(1),
    ammoCapacityLevel: integer('ammo_capacity_level').notNull().default(1),
    regenLevel: integer('regen_level').notNull().default(1),
    cannonSlots: integer('cannon_slots').notNull().default(1),
    marqueLevel: integer('marque_level').notNull().default(0),
    ownedSkinIds: text('owned_skin_ids', { mode: 'json' }).$type<string[]>().notNull().default(['starter']),
    equippedSkinId: text('equipped_skin_id').notNull().default('starter'),
    ownedAbilityIds: text('owned_ability_ids', { mode: 'json' }).$type<string[]>().notNull().default(['bomb']),
    equippedAbilityId: text('equipped_ability_id').notNull().default('bomb'),
    // Level of each ability; a missing key is level 1.
    abilityLevels: text('ability_levels', { mode: 'json' }).$type<Record<string, number>>().notNull().default({}),
    runsPlayed: integer('runs_played').notNull().default(0),
    bestSurvivalMs: integer('best_survival_ms').notNull().default(0),
    // Only full six-minute clears move these. -1 means no clear yet.
    highestCompletedDifficulty: integer('highest_completed_difficulty').notNull().default(-1),
    bestCompletedLoot: integer('best_completed_loot').notNull().default(0),
    bestCompletedPower: integer('best_completed_power').notNull().default(0),
    bestCompletedSkinId: text('best_completed_skin_id').notNull().default('starter'),
    // The voyage at sea: set by start-run, cleared by finish-run (the clear is
    // the guard: one finish settles a voyage). The server clock and the power
    // and difficulty snapshots bound what the voyage can pay.
    runId: text('run_id'),
    runStartedAt: integer('run_started_at', { mode: 'timestamp_ms' }),
    runPower: integer('run_power'),
    runDifficulty: integer('run_difficulty')
})

/** Fitted cannons, one row per occupied gun port. `purchasePrice` prices the trade-in. */
export const pirateCannons = sqliteTable('pirate_cannons', {
    playerId: text('player_id').notNull().references(() => players.id, { onDelete: 'cascade' }),
    slotIndex: integer('slot_index').notNull(),
    tierId: text('tier_id').notNull(),
    purchasePrice: integer('purchase_price').notNull()
}, table => [primaryKey({ columns: [table.playerId, table.slotIndex] })])

/** Settled voyages (the captain's log). */
export const pirateRuns = sqliteTable('pirate_runs', {
    id: text('id').primaryKey(),
    playerId: text('player_id').notNull().references(() => players.id, { onDelete: 'cascade' }),
    loot: integer('loot').notNull(),
    durationMs: integer('duration_ms').notNull(),
    power: integer('power').notNull(),
    difficulty: integer('difficulty').notNull(),
    survived: integer('survived', { mode: 'boolean' }).notNull(),
    completed: integer('completed', { mode: 'boolean' }).notNull(),
    reason: text('reason', { enum: ['timeout', 'defeat', 'cancelled'] }).notNull(),
    kills: integer('kills').notNull(),
    shotsFired: integer('shots_fired').notNull(),
    skinId: text('skin_id').notNull(),
    createdAt: createdAt()
}, table => [index('pirate_runs_player_idx').on(table.playerId, table.createdAt)])
