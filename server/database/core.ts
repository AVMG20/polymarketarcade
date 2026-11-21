import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Platform tables and column helpers. Timestamps are Unix milliseconds. */

export const createdAt = () => integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch('subsec') * 1000)`)
export const updatedAt = () => integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch('subsec') * 1000)`)

/**
 * A hub account as the arcade knows it. The id is the hub user id (the launch
 * token's `sub`); name, image and title mirror the token at each launch.
 */
export const players = sqliteTable('players', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    image: text('image'),
    title: text('title'),
    // 'hub' players arrived with a launch token; 'dev' players come from the
    // dev login and never touch the hub.
    origin: text('origin', { enum: ['hub', 'dev'] }).notNull().default('hub'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
})

/** Launch-token ids already exchanged for a session; a jti is accepted once. */
export const launchTokens = sqliteTable('launch_tokens', {
    jti: text('jti').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull()
}, table => [index('launch_tokens_expires_idx').on(table.expiresAt)])
