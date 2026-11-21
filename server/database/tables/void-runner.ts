import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { createdAt, players } from '../core'

/**
 * Void Runner pilot state, one row per player. Materials banked by resource
 * id; cargo carried mid-run only lands here when the run docks.
 */
export const voidState = sqliteTable('void_state', {
    playerId: text('player_id').primaryKey().references(() => players.id, { onDelete: 'cascade' }),
    resources: text('resources', { mode: 'json' }).$type<Record<string, number>>().notNull().default({}),
    ownedShipIds: text('owned_ship_ids', { mode: 'json' }).$type<string[]>().notNull().default(['sparrow']),
    equippedShipId: text('equipped_ship_id').notNull().default('sparrow'),
    // Hull tier per ship id, only for hulls refitted above the tier they were built at.
    shipTiers: text('ship_tiers', { mode: 'json' }).$type<Record<string, number>>().notNull().default({}),
    // Gear fitted to each hull, keyed by ship id: { gun, turrets[], armor[], shields[], secondary, device }.
    loadouts: text('loadouts', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    // Relic mods waiting to be socketed, by mod id.
    mods: text('mods', { mode: 'json' }).$type<Record<string, number>>().notNull().default({}),
    // Set once the free starter kit has been handed out (the flip is the claim).
    starterGranted: integer('starter_granted', { mode: 'boolean' }).notNull().default(false),
    // Daily limits on the rare meta rewards (UTC day key), so forged reports buy little.
    rewardsDay: text('rewards_day'),
    marksToday: integer('marks_today').notNull().default(0),
    blueprintsToday: integer('blueprints_today').notNull().default(0),
    gearToday: integer('gear_today').notNull().default(0),
    relicsToday: integer('relics_today').notNull().default(0),
    // Command Marks and the perks bought with them, blueprints for MkII gear, recovered lore logs.
    marks: integer('marks').notNull().default(0),
    perks: text('perks', { mode: 'json' }).$type<Record<string, number>>().notNull().default({}),
    blueprints: text('blueprints', { mode: 'json' }).$type<string[]>().notNull().default([]),
    lore: text('lore', { mode: 'json' }).$type<string[]>().notNull().default([]),
    // Captured extraction beacons, keyed `sector:slot`; `at` is epoch ms of the capture or last defence.
    beacons: text('beacons', { mode: 'json' }).$type<Record<string, { at: number, attacked?: boolean }>>().notNull().default({}),
    upgradeLevels: text('upgrade_levels', { mode: 'json' }).$type<Record<string, number>>().notNull().default({}),
    // 0 until the first warden is killed and docked home.
    highestSectorCleared: integer('highest_sector_cleared').notNull().default(0),
    runsPlayed: integer('runs_played').notNull().default(0),
    extractions: integer('extractions').notNull().default(0),
    kills: integer('kills').notNull().default(0),
    wardensKilled: integer('wardens_killed').notNull().default(0),
    bestHaulValue: integer('best_haul_value').notNull().default(0),
    // Set on launch, cleared on finish. The snapshots stop a mid-run refit from
    // raising what an in-flight run may bank.
    runStartedAt: integer('run_started_at', { mode: 'timestamp_ms' }),
    runSector: integer('run_sector'),
    runShipId: text('run_ship_id'),
    runCargo: integer('run_cargo'),
    pilotXp: integer('pilot_xp').notNull().default(0),
    // Supplies in stock at the station, and what the current run took with it.
    supplies: text('supplies', { mode: 'json' }).$type<Record<string, number>>().notNull().default({}),
    runSupplies: text('run_supplies', { mode: 'json' }).$type<Record<string, number>>(),
    // Station contracts delivered today (UTC day key + indices).
    contractsDay: text('contracts_day'),
    contractsDone: text('contracts_done', { mode: 'json' }).$type<number[]>().notNull().default([]),
    unlockedSkills: text('unlocked_skills', { mode: 'json' }).$type<string[]>().notNull().default(['seeker']),
    equippedSkill: text('equipped_skill').notNull().default('seeker'),
    skillNodes: text('skill_nodes', { mode: 'json' }).$type<Record<string, string[]>>().notNull().default({})
})

/** Crafted gear. Tier, rarity and affixes are rolled on the server at craft time. */
export const voidItems = sqliteTable('void_items', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    playerId: text('player_id').notNull().references(() => players.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    type: text('type').notNull(),
    tier: integer('tier').notNull().default(1),
    rarity: integer('rarity').notNull().default(0),
    level: integer('level').notNull().default(0),
    affixes: text('affixes', { mode: 'json' }).$type<Record<string, number>>().notNull().default({}),
    mod: text('mod'),
    createdAt: createdAt()
}, table => [index('void_items_player_idx').on(table.playerId)])

export const voidRunHistory = sqliteTable('void_run_history', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    playerId: text('player_id').notNull().references(() => players.id, { onDelete: 'cascade' }),
    sector: integer('sector').notNull().default(1),
    shipId: text('ship_id').notNull().default('sparrow'),
    durationMs: integer('duration_ms').notNull().default(0),
    haul: text('haul', { mode: 'json' }).$type<Record<string, number>>().notNull().default({}),
    haulValue: integer('haul_value').notNull().default(0),
    extracted: integer('extracted', { mode: 'boolean' }).notNull().default(false),
    reason: text('reason').notNull(),
    kills: integer('kills').notNull().default(0),
    wardenKilled: integer('warden_killed', { mode: 'boolean' }).notNull().default(false),
    // Balance audit blob: the ship that flew, what the server granted and the run's own telemetry.
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: createdAt()
}, table => [index('void_run_history_player_idx').on(table.playerId, table.createdAt)])
