import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { createdAt, players, updatedAt } from '../core'
import type { Entity as GridEntity } from '../../../shared/gridworks/layout'

/**
 * Gridworks: one factory plot per player. The economy is date-based: the
 * steady-state rates of the layout times the time since lastSettledAt, settled
 * inside a `writeTx` on every write, so nothing ticks on the server.
 */
export const gridworksPlot = sqliteTable('gridworks_plot', {
    playerId: text('player_id').primaryKey().references(() => players.id, { onDelete: 'cascade' }),
    /** Ore map seed. */
    seed: integer('seed').notNull(),
    entities: text('entities', { mode: 'json' }).$type<GridEntity[]>().notNull().default([]),
    chunks: text('chunks', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** Items in storage (fractional between settles). */
    stock: text('stock', { mode: 'json' }).$type<Record<string, number>>().notNull().default({}),
    researchDone: text('research_done', { mode: 'json' }).$type<string[]>().notNull().default([]),
    researchQueue: text('research_queue', { mode: 'json' }).$type<string[]>().notNull().default([]),
    researchProgress: text('research_progress', { mode: 'json' }).$type<Record<string, Record<string, number>>>().notNull().default({}),
    mine: text('mine', { mode: 'json' }).$type<{ tokens: number, at: number }>().notNull().default({ tokens: 0, at: 0 }),
    /** Bumped on every layout change; keys the solver cache. */
    layoutVersion: integer('layout_version').notNull().default(1),
    /** Goals claimed, in order. */
    goals: text('goals', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** Ore dug by hand, ever. */
    mined: integer('mined').notNull().default(0),
    lastSettledAt: integer('last_settled_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch('subsec') * 1000)`),
    createdAt: createdAt(),
    updatedAt: updatedAt()
})
