import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { createdAt, players, updatedAt } from '../core'
import type { TownBoosters } from '../../../shared/polytown/town-boosts'
import type { TownEventData } from '../../../shared/polytown/town-events'
import type { TownRedesignDraft } from '../../../shared/polytown/town-storage'
import type { TownStreakLock } from '../../../shared/polytown/town-streak'

/**
 * Polytown, the plot-based idle town builder. Timestamps are Unix ms. Prices
 * are coins with up to two decimals (REAL); a town's own coin balance is kept
 * in whole cents (`coinsCents`) so debits and credits stay exact.
 */

/**
 * One row per player town. Production is settled lazily from elapsed real time
 * (server/utils/polytown/town.ts:settleTownState) inside a `writeTx`: there is
 * no server-side loop. Happiness and tick progress are the only simulation
 * carry-overs; everything else is derived from buildings + inventory.
 */
export const polytownState = sqliteTable('polytown_state', {
    playerId: text('player_id').primaryKey().references(() => players.id, { onDelete: 'cascade' }),
    /** The town's coins, in cents. Every coin the old site's balance paid or charged moves through here. */
    coinsCents: integer('coins_cents').notNull().default(0),
    happiness: integer('happiness').notNull().default(50),
    /** Speed-scaled ms of progress toward the next tick, carried between settles. */
    tickProgressMs: integer('tick_progress_ms').notNull().default(0),
    lastSettledAt: integer('last_settled_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch('subsec') * 1000)`),
    /** Plots ever bought from the system (the founding plot counts). Drives price + cooldown. */
    plotsBought: integer('plots_bought').notNull().default(1),
    lastPlotBoughtAt: integer('last_plot_bought_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch('subsec') * 1000)`),
    /** Milestone ids already paid out. Claiming appends under a NOT-contains guard (claim-then-reward). */
    milestonesClaimed: text('milestones_claimed', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** Lifetime coins earned from selling to the town hall. Drives the merchant milestones. */
    coinsEarned: real('coins_earned').notNull().default(0),
    /** Lifetime units produced per resource: the tier gate a rich mayor cannot buy past. */
    produced: text('produced', { mode: 'json' }).$type<Record<string, number>>().notNull().default({}),
    /** Build crews owned. Three come free; the rest are bought with platform gems, permanently. */
    builders: integer('builders').notNull().default(3),
    /** Per building, per resource: fractions of a unit made but not yet handed over, carried between ticks. */
    carry: text('carry', { mode: 'json' }).$type<Record<string, Record<string, number>>>().notNull().default({}),
    /**
     * Monument stages carried over from the retired research board, by monument
     * id: placing that monument puts it up at this stage at once, free. Taken
     * with a conditional update when it is used, so it can only be spent once.
     */
    monumentCredit: text('monument_credit', { mode: 'json' }).$type<Record<string, number>>().notNull().default({}),
    /** Builder's rush: every build job runs at double speed until then. Null or past means off. */
    buildBoostUntil: integer('build_boost_until', { mode: 'timestamp_ms' }),
    /** Production surge: the settle doubles production up to then. Null or past means off. */
    productionBoostUntil: integer('production_boost_until', { mode: 'timestamp_ms' }),
    /** A borrowed build crew on top of `builders` while this is in the future. */
    tempBuilderUntil: integer('temp_builder_until', { mode: 'timestamp_ms' }),
    /** Market day: town-hall floor sales pay extra until then, out of `marketBoostBonusLeft`. */
    marketBoostUntil: integer('market_boost_until', { mode: 'timestamp_ms' }),
    /** Coins market day may still add on top of floor sales. */
    marketBoostBonusLeft: real('market_boost_bonus_left').notNull().default(0),
    /** Boosters waiting to be started, by kind. Rewards add to it; starting one takes one off. */
    boosters: text('boosters', { mode: 'json' }).$type<TownBoosters>().notNull().default({}),
    createdAt: createdAt()
})

/**
 * Buildings a town owns but has taken off the map. A row keeps the building's
 * own id, and moves back into polytown_buildings when it is placed. Its own
 * table, with no plot or tile, so a stored building can never produce, house
 * or be counted by mistake, and selling the plot it stood on cannot cascade it.
 */
export const polytownStorage = sqliteTable('polytown_storage', {
    id: text('id').primaryKey(),
    playerId: text('player_id').notNull().references(() => players.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    level: integer('level').notNull(),
    upgradingTo: integer('upgrading_to'),
    /** Build time still owed on a paused construction or upgrade; 0 when idle. */
    remainingMs: integer('remaining_ms').notNull().default(0),
    /** The building's own creation time, carried through storage. */
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    storedAt: integer('stored_at', { mode: 'timestamp_ms' }).notNull()
}, table => [index('polytown_storage_player_idx').on(table.playerId)])

/** A redesign saved half-way: only a plan; the town runs on its real layout until the redesign is saved. */
export const polytownRedesignDrafts = sqliteTable('polytown_redesign_drafts', {
    playerId: text('player_id').primaryKey().references(() => players.id, { onDelete: 'cascade' }),
    draft: text('draft', { mode: 'json' }).$type<TownRedesignDraft>().notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
})

/**
 * One 8x8 plot on the shared endless grid. The unique (x, y) index is the
 * claim guard. Founding plots take the first free square on a spiral from the
 * origin; later plots must touch one the player already owns.
 */
export const polytownPlots = sqliteTable('polytown_plots', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    playerId: text('player_id').notNull().references(() => players.id, { onDelete: 'cascade' }),
    x: integer('x').notNull(),
    y: integer('y').notNull(),
    /** Asking price while the owner has this (empty) plot on the market, else null. */
    listPrice: real('list_price'),
    /** What the current owner paid the land office for this square (0 for founding or a player sale). The refund is a share of this. */
    paidPrice: real('paid_price').notNull().default(0),
    createdAt: createdAt()
}, table => [
    index('polytown_plots_player_idx').on(table.playerId),
    uniqueIndex('polytown_plots_xy_unique').on(table.x, table.y)
])

/**
 * One building on one tile. level 0 = still under first construction
 * (completesAt in the future). upgradingTo is set while an upgrade is in
 * progress; settle bakes it into level once completesAt passes.
 */
export const polytownBuildings = sqliteTable('polytown_buildings', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    playerId: text('player_id').notNull().references(() => players.id, { onDelete: 'cascade' }),
    plotId: text('plot_id').notNull().references(() => polytownPlots.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    tileX: integer('tile_x').notNull(),
    tileY: integer('tile_y').notNull(),
    /** Clockwise quarter turns; cosmetic only. */
    rotation: integer('rotation').notNull().default(0),
    level: integer('level').notNull().default(0),
    upgradingTo: integer('upgrading_to'),
    completesAt: integer('completes_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: createdAt()
}, table => [
    index('polytown_buildings_player_idx').on(table.playerId),
    uniqueIndex('polytown_buildings_tile_unique').on(table.plotId, table.tileX, table.tileY)
])

/** What each settle produced, per resource: the data behind the production chart. */
export const polytownProduction = sqliteTable('polytown_production', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    playerId: text('player_id').notNull().references(() => players.id, { onDelete: 'cascade' }),
    resource: text('resource').notNull(),
    amount: integer('amount').notNull(),
    /** Window covered by the settle, so bucketing can spread it over the hours it spanned. */
    fromAt: integer('from_at', { mode: 'timestamp_ms' }).notNull(),
    toAt: integer('to_at', { mode: 'timestamp_ms' }).notNull()
}, table => [index('polytown_production_player_to_idx').on(table.playerId, table.toAt)])

/** Per-player resource stock. Always written as increments (amount = amount + delta). */
export const polytownInventory = sqliteTable('polytown_inventory', {
    playerId: text('player_id').notNull().references(() => players.id, { onDelete: 'cascade' }),
    resource: text('resource').notNull(),
    amount: integer('amount').notNull().default(0)
}, table => [primaryKey({ columns: [table.playerId, table.resource] })])

/** Per-resource limit order book. Buys escrow town coins, sells escrow the resource. */
export const polytownOrders = sqliteTable('polytown_orders', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    playerId: text('player_id').notNull().references(() => players.id, { onDelete: 'cascade' }),
    resource: text('resource').notNull(),
    side: text('side', { enum: ['buy', 'sell'] }).notNull(),
    price: real('price').notNull(),
    quantity: integer('quantity').notNull(),
    filled: integer('filled').notNull().default(0),
    status: text('status', { enum: ['open', 'filled', 'cancelled'] }).notNull().default('open'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
}, table => [
    index('polytown_orders_book_idx').on(table.resource, table.status, table.side, table.price),
    index('polytown_orders_player_idx').on(table.playerId, table.status)
])

/** One row per executed match: the per-resource price history. */
export const polytownTrades = sqliteTable('polytown_trades', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    resource: text('resource').notNull(),
    buyerId: text('buyer_id').references(() => players.id, { onDelete: 'set null' }),
    sellerId: text('seller_id').references(() => players.id, { onDelete: 'set null' }),
    takerId: text('taker_id').references(() => players.id, { onDelete: 'set null' }),
    price: real('price').notNull(),
    quantity: integer('quantity').notNull(),
    createdAt: createdAt()
}, table => [
    index('polytown_trades_resource_created_idx').on(table.resource, table.createdAt),
    index('polytown_trades_buyer_idx').on(table.buyerId),
    index('polytown_trades_seller_idx').on(table.sellerId),
    index('polytown_trades_taker_idx').on(table.takerId)
])

/**
 * What happened to a town while its mayor was not looking. `createdAt` is the
 * moment the thing happened (a build finished hours ago lists at that time).
 */
export const polytownEvents = sqliteTable('polytown_events', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    playerId: text('player_id').notNull().references(() => players.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    data: text('data', { mode: 'json' }).$type<TownEventData>().notNull(),
    createdAt: createdAt()
}, table => [index('polytown_events_player_created_idx').on(table.playerId, table.createdAt)])

/**
 * The day's three town hall contracts, rolled once per UTC day on first sight
 * and never rerolled. Delivering flips `delivered` with a conditional update.
 */
export const polytownContracts = sqliteTable('polytown_contracts', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    playerId: text('player_id').notNull().references(() => players.id, { onDelete: 'cascade' }),
    /** UTC day key, 'YYYY-MM-DD'. */
    day: text('day').notNull(),
    slot: integer('slot').notNull(),
    resource: text('resource').notNull(),
    quantity: integer('quantity').notNull(),
    /** Town coins paid on delivery. */
    reward: real('reward').notNull(),
    delivered: integer('delivered', { mode: 'boolean' }).notNull().default(false),
    deliveredAt: integer('delivered_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt()
}, table => [uniqueIndex('polytown_contracts_player_day_slot_unique').on(table.playerId, table.day, table.slot)])

/** One row per town per contract day: the booster bonus for delivering all three, paid once by flipping `bonusClaimed`. */
export const polytownContractDays = sqliteTable('polytown_contract_days', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    playerId: text('player_id').notNull().references(() => players.id, { onDelete: 'cascade' }),
    day: text('day').notNull(),
    bonus: text('bonus', { mode: 'json' }).$type<TownBoosters>().notNull(),
    bonusClaimed: integer('bonus_claimed', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt()
}, table => [uniqueIndex('polytown_contract_days_player_day_unique').on(table.playerId, table.day)])

/**
 * The mayor's daily streak: a 30-step reward track. Claims set a bit in
 * `claimed` with a conditional update; reset pays every unclaimed step, then
 * starts over.
 */
export const polytownStreak = sqliteTable('polytown_streak', {
    playerId: text('player_id').primaryKey().references(() => players.id, { onDelete: 'cascade' }),
    /** Steps unlocked in this run, 0..30. */
    step: integer('step').notNull().default(0),
    /** UTC day key of the last step unlocked; null before the first visit. */
    lastDay: text('last_day'),
    /** Bit i set once step i + 1 has been paid. */
    claimed: integer('claimed').notNull().default(0),
    /** Completed or abandoned runs, for display. */
    cycle: integer('cycle').notNull().default(0),
    /** Per unlocked step: the town's scale and the payout, fixed the day it unlocked. */
    locked: text('locked', { mode: 'json' }).$type<Record<string, TownStreakLock>>().notNull().default({}),
    /** Lucky charges: each upgrades the next chest opened by one tier. */
    lucky: integer('lucky').notNull().default(0),
    updatedAt: updatedAt()
})

/**
 * Platform gems spent on a Polytown perk. The hub charged them; this row says
 * the perk was applied (inserted in the same transaction, keyed by the
 * purchase's idempotency key, so a retried purchase is applied once) or
 * refunded because applying it failed.
 */
export const polytownGemSpends = sqliteTable('polytown_gem_spends', {
    idempotencyKey: text('idempotency_key').primaryKey(),
    playerId: text('player_id').notNull().references(() => players.id, { onDelete: 'cascade' }),
    spendId: text('spend_id').notNull(),
    /** 'rush' | 'builder' | 'booster:<kind>'. */
    perk: text('perk').notNull(),
    gems: integer('gems').notNull(),
    status: text('status', { enum: ['applied', 'refunded'] }).notNull(),
    createdAt: createdAt()
}, table => [index('polytown_gem_spends_player_idx').on(table.playerId)])
