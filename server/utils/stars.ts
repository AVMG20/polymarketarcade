import { and, eq, inArray } from 'drizzle-orm'
import { db } from '#server/database/index'
import { deadFrontProfiles, gridworksPlot, pirateState, polytownBuildings, polytownState, polytownStorage, shapezzState, starReports, voidState } from '#server/database/schema'
import { ARCADE_GAMES } from '#shared/games'
import { TOWN_MONUMENT_IDS } from '#shared/polytown/town-monuments'
import { deadFrontStars, gridworksStars, pirateStars, polytownStars, shapezzStars, voidStars } from '#shared/stars'
import { arcadeEnv } from './env'
import { hub, HubError } from './hub'

/**
 * Tells the hub each player's star level per game. The level comes from the
 * saved progress (shared/stars.ts); `star_reports` holds what the hub last
 * confirmed, so only a changed level is sent, and one that failed (hub down,
 * a player who never connected there) is sent again on the next sync.
 */

type Slug = 'dead-front' | 'shapezz' | 'pirate-raid' | 'void-runner' | 'polytown' | 'gridworks'

const LEVEL: Record<Slug, (playerId: string) => number> = {
    'dead-front': (id) => {
        const row = db.select({ perks: deadFrontProfiles.perkLevels }).from(deadFrontProfiles).where(eq(deadFrontProfiles.playerId, id)).get()
        return row ? deadFrontStars(row.perks) : 0
    },
    'shapezz': (id) => {
        const row = db.select({ best: shapezzState.bestCheckpoint }).from(shapezzState).where(eq(shapezzState.playerId, id)).get()
        return row ? shapezzStars(row.best) : 0
    },
    'pirate-raid': (id) => {
        const row = db.select({ best: pirateState.highestCompletedDifficulty }).from(pirateState).where(eq(pirateState.playerId, id)).get()
        return row ? pirateStars(row.best) : 0
    },
    'void-runner': (id) => {
        const row = db.select({ best: voidState.highestSectorCleared }).from(voidState).where(eq(voidState.playerId, id)).get()
        return row ? voidStars(row.best) : 0
    },
    // Monument stages built, on the map or in storage. A stage whose timer ran
    // out counts at once, settled or not, so the level never waits on a visit.
    'polytown': (id) => {
        const now = Date.now()
        const monuments = [...TOWN_MONUMENT_IDS]
        let stages = 0
        for (const b of db.select({ level: polytownBuildings.level, upgradingTo: polytownBuildings.upgradingTo, completesAt: polytownBuildings.completesAt })
            .from(polytownBuildings).where(and(eq(polytownBuildings.playerId, id), inArray(polytownBuildings.type, monuments))).all()) {
            stages += b.completesAt.getTime() <= now ? (b.upgradingTo ?? Math.max(b.level, 1)) : b.level
        }
        for (const s of db.select({ level: polytownStorage.level }).from(polytownStorage)
            .where(and(eq(polytownStorage.playerId, id), inArray(polytownStorage.type, monuments))).all()) {
            stages += s.level
        }
        return polytownStars(stages)
    },
    'gridworks': (id) => {
        const row = db.select({ goals: gridworksPlot.goals }).from(gridworksPlot).where(eq(gridworksPlot.playerId, id)).get()
        return row ? gridworksStars(row.goals) : 0
    }
}

const listed = (): Slug[] => ARCADE_GAMES.map(g => g.slug).filter((slug): slug is Slug => slug in LEVEL)

function reported(playerId: string, game: string): number {
    return db.select({ stars: starReports.stars }).from(starReports)
        .where(and(eq(starReports.playerId, playerId), eq(starReports.game, game))).get()?.stars ?? 0
}

/**
 * Send any of the player's levels the hub doesn't have yet (one game, or all).
 * Returns the levels the hub confirmed in this call; never throws.
 */
export async function syncStars(playerId: string, game?: Slug): Promise<{ game: string, stars: number }[]> {
    const changed: { game: string, stars: number }[] = []
    if (!arcadeEnv().appKey) return changed
    for (const slug of game ? [game] : listed()) {
        const stars = LEVEL[slug](playerId)
        if (stars === reported(playerId, slug)) continue
        try {
            const result = await hub.setStars({ playerId, game: slug, stars, seq: Date.now() })
            db.insert(starReports).values({ playerId, game: slug, stars: result.stars, updatedAt: new Date() })
                .onConflictDoUpdate({ target: [starReports.playerId, starReports.game], set: { stars: result.stars, updatedAt: new Date() } })
                .run()
            if (result.applied) changed.push({ game: slug, stars: result.stars })
        } catch (error) {
            // 403: the player never connected at the hub; retried on their next launch.
            if (!(error instanceof HubError && error.statusCode === 403)) console.warn(`[stars] ${slug} for ${playerId}: ${(error as Error).message}`)
        }
    }
    return changed
}

/**
 * The star level a progress write just changed, for the page to pass to the
 * hub (app/utils/api.ts does it for every response that has one), or null.
 */
export async function syncStar(playerId: string, game: Slug): Promise<{ game: string, stars: number } | null> {
    const [change] = await syncStars(playerId, game)
    return change ?? null
}

/** Send every pending level for every player (boot and hourly): the backfill. */
export async function syncAllStars(): Promise<number> {
    const ids = new Set<string>()
    for (const table of [deadFrontProfiles, shapezzState, pirateState, voidState, polytownState, gridworksPlot]) {
        for (const row of db.select({ id: table.playerId }).from(table).all()) ids.add(row.id)
    }
    let sent = 0
    for (const id of ids) sent += (await syncStars(id)).length
    return sent
}
