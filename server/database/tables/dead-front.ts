import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { DfLoadout, DfPerkId, DfWeaponId } from '#shared/dead-front/types'
import { createdAt, players, updatedAt } from '../core'

/**
 * Dead Front per-player progression. Weapons unlock by being found in a match,
 * attachments by weapon level (kills with it), and perk research levels are
 * bought with medals, which only the server's own match result pays out.
 */
export const deadFrontProfiles = sqliteTable('dead_front_profiles', {
    playerId: text('player_id').primaryKey().references(() => players.id, { onDelete: 'cascade' }),
    unlockedWeapons: text('unlocked_weapons', { mode: 'json' }).$type<DfWeaponId[]>().notNull().default(['m1911']),
    weaponXp: text('weapon_xp', { mode: 'json' }).$type<Partial<Record<DfWeaponId, number>>>().notNull().default({}),
    loadout: text('loadout', { mode: 'json' }).$type<DfLoadout>().notNull().default({ startWeapon: 'm1911', attachments: {} }),
    // Research level (0-6) bought per perk; each level unlocks one modifier.
    perkLevels: text('perk_levels', { mode: 'json' }).$type<Partial<Record<DfPerkId, number>>>().notNull().default({}),
    perkMods: text('perk_mods', { mode: 'json' }).$type<Partial<Record<DfPerkId, string[]>>>().notNull().default({}),
    // Spendable medals: match results add them, research spends them.
    medals: integer('medals').notNull().default(0),
    medalsEarned: integer('medals_earned').notNull().default(0),
    gamesPlayed: integer('games_played').notNull().default(0),
    bestRound: integer('best_round').notNull().default(0),
    totalKills: integer('total_kills').notNull().default(0),
    eggsCompleted: integer('eggs_completed').notNull().default(0),
    updatedAt: updatedAt()
})

/**
 * One row per player per match, written in the same transaction as the
 * profile merge. The primary key is the guard: a match result applies once.
 */
export const deadFrontResults = sqliteTable('dead_front_results', {
    matchId: text('match_id').notNull(),
    playerId: text('player_id').notNull().references(() => players.id, { onDelete: 'cascade' }),
    round: integer('round').notNull(),
    kills: integer('kills').notNull(),
    medals: integer('medals').notNull(),
    createdAt: createdAt()
}, table => [
    primaryKey({ columns: [table.matchId, table.playerId] }),
    index('dead_front_results_player_idx').on(table.playerId, table.createdAt)
])
