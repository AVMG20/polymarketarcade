import { desc, eq, gt, inArray } from 'drizzle-orm'
import { db } from '#server/database'
import { players, voidItems, voidState } from '#server/database/schema'
import { requirePlayerId } from '#server/utils/session'
import { voidDerivedStats, voidGearTier, voidLoadoutFor, voidPowerRating, voidShip } from '#shared/void-runner/void'
import { VOID_RARITIES, voidItemName, type VoidItem, type VoidItemKind } from '#shared/void-runner/void-items'
import { voidPilotLevel } from '#shared/void-runner/void-skills'

/** The top 25 pilots by deepest sector cleared, then best haul. */
export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const rows = db
        .select({ name: players.name, image: players.image, state: voidState })
        .from(voidState)
        .innerJoin(players, eq(players.id, voidState.playerId))
        .where(gt(voidState.runsPlayed, 0))
        .orderBy(desc(voidState.highestSectorCleared), desc(voidState.bestHaulValue))
        .limit(25)
        .all()
    // Every pilot's gear in one query, so power and the fitted hull come from what they actually fly.
    const itemRows = rows.length ? db.select().from(voidItems).where(inArray(voidItems.playerId, rows.map(r => r.state.playerId))).all() : []
    const itemsByPlayer = new Map<string, VoidItem[]>()
    for (const r of itemRows) {
        const list = itemsByPlayer.get(r.playerId) ?? []
        list.push({ id: r.id, kind: r.kind as VoidItemKind, type: r.type, tier: r.tier, rarity: r.rarity, level: r.level, affixes: r.affixes ?? {}, mod: r.mod })
        itemsByPlayer.set(r.playerId, list)
    }
    return rows.map(({ name, image, state: s }, i) => {
        const items = itemsByPlayer.get(s.playerId) ?? []
        const byId = new Map(items.map(item => [item.id, item]))
        const loadout = voidLoadoutFor(s, items)
        const stats = voidDerivedStats(loadout.shipId, loadout.levels, loadout.fit, items, loadout.perks, loadout.shipTier)
        const gear = (id: string | null) => {
            const item = id ? byId.get(id) : undefined
            if (!item) return null
            return { name: voidItemName(item), type: item.type, tier: item.tier, level: item.level, rarityColor: VOID_RARITIES[item.rarity]?.color ?? VOID_RARITIES[0]!.color }
        }
        return {
            rank: i + 1,
            name,
            image,
            cleared: s.highestSectorCleared,
            bestHaulValue: s.bestHaulValue,
            kills: s.kills,
            wardensKilled: s.wardensKilled,
            runsPlayed: s.runsPlayed,
            pilotLevel: voidPilotLevel(s.pilotXp ?? 0),
            shipId: loadout.shipId,
            shipName: voidShip(loadout.shipId).name,
            shipTier: loadout.shipTier,
            power: voidPowerRating(loadout, stats),
            gearTier: voidGearTier(loadout.shipId, loadout.fit, items),
            hull: stats.hull,
            shield: stats.shield,
            turretTypes: loadout.turrets.map(t => t?.type ?? null),
            gun: gear(loadout.fit.gun),
            turrets: loadout.fit.turrets.map(gear),
            isCurrentUser: s.playerId === playerId
        }
    })
})
