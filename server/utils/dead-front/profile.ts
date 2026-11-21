import { and, eq, gte, sql } from 'drizzle-orm'
import { db, writeTx, type DbExecutor } from '#server/database'
import { deadFrontProfiles, deadFrontResults } from '#server/database/schema'
import { dfMedalsFromMatch, dfResearchCost } from '#shared/dead-front/progression'
import type { DfMatchResult, DfPerkId, DfProfileView, DfProgressReport } from '#shared/dead-front/types'
import { dfMergeMatchResult, dfNormalizeProfile } from './profile-rules'

// Dead Front progression storage. Every read-modify-write runs in writeTx
// (BEGIN IMMEDIATE, synchronous), so two requests can't interleave between
// the read and the write; the medal spend also guards in its UPDATE.

function readProfile(ex: DbExecutor, playerId: string): DfProfileView {
    ex.insert(deadFrontProfiles).values({ playerId }).onConflictDoNothing().run()
    const row = ex.select().from(deadFrontProfiles).where(eq(deadFrontProfiles.playerId, playerId)).get()
    if (!row) throw createError({ statusCode: 500, statusMessage: 'Profile missing' })
    return dfNormalizeProfile(row)
}

function writeProfile(ex: DbExecutor, playerId: string, next: DfProfileView) {
    ex.update(deadFrontProfiles).set({
        unlockedWeapons: next.unlockedWeapons,
        weaponXp: next.weaponXp,
        loadout: next.loadout,
        perkLevels: next.perkLevels,
        perkMods: next.perkMods,
        medals: next.medals,
        medalsEarned: next.medalsEarned,
        gamesPlayed: next.gamesPlayed,
        bestRound: next.bestRound,
        totalKills: next.totalKills,
        eggsCompleted: next.eggsCompleted,
        updatedAt: new Date()
    }).where(eq(deadFrontProfiles.playerId, playerId)).run()
}

/** The player's profile, created with defaults on first read. */
export function getDfProfile(playerId: string): DfProfileView {
    return readProfile(db, playerId)
}

/**
 * Runs `fn` on the normalised profile inside one write transaction and writes
 * back what it returns. `fn` must be synchronous and may throw to abort.
 */
export function withLockedDfProfile<T>(playerId: string, fn: (view: DfProfileView) => { next: DfProfileView, out: T }): T {
    return writeTx((tx) => {
        const { next, out } = fn(readProfile(tx, playerId))
        writeProfile(tx, playerId, next)
        return out
    })
}

/**
 * Applies one match's result (weapon unlocks, weapon XP, medals, stats). The
 * (match, player) row is the guard: a second call for the same match returns
 * null and changes nothing. Only the server match calls this, with its own
 * simulation's result.
 */
export function applyDfMatchResult(playerId: string, matchId: string, result: DfMatchResult): DfProgressReport | null {
    return writeTx((tx) => {
        const claimed = tx.insert(deadFrontResults).values({
            matchId,
            playerId,
            round: Math.max(0, Math.floor(result.roundsSurvived) || 0),
            kills: Math.max(0, Math.floor(result.kills) || 0),
            medals: dfMedalsFromMatch(result)
        }).onConflictDoNothing().returning({ matchId: deadFrontResults.matchId }).get()
        if (!claimed) return null
        const { next, report } = dfMergeMatchResult(readProfile(tx, playerId), result)
        writeProfile(tx, playerId, next)
        return report
    })
}

/**
 * Buys the next research level of a perk. The UPDATE spends only while the
 * balance covers it and the level is still the one read.
 */
export function researchDfPerk(playerId: string, perk: DfPerkId): DfProfileView {
    return writeTx((tx) => {
        const view = readProfile(tx, playerId)
        const level = view.perkLevels[perk] ?? 0
        const cost = dfResearchCost(level)
        if (cost === null) throw createError({ statusCode: 400, statusMessage: 'Fully researched' })
        if (view.medals < cost) throw createError({ statusCode: 400, statusMessage: 'Not enough medals' })
        const perkLevels = { ...view.perkLevels, [perk]: level + 1 }
        const spent = tx.update(deadFrontProfiles)
            .set({ medals: sql`${deadFrontProfiles.medals} - ${cost}`, perkLevels, updatedAt: new Date() })
            .where(and(
                eq(deadFrontProfiles.playerId, playerId),
                gte(deadFrontProfiles.medals, cost),
                sql`coalesce(json_extract(${deadFrontProfiles.perkLevels}, ${`$.${perk}`}), 0) = ${level}`
            ))
            .returning({ medals: deadFrontProfiles.medals })
            .get()
        if (!spent) throw createError({ statusCode: 400, statusMessage: 'Not enough medals' })
        return { ...view, perkLevels, medals: spent.medals }
    })
}
