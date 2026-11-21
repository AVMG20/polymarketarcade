import { requirePlayerId } from '#server/utils/session'
import { getShapezzState, shapezzArsenal, shapezzEquippedWeapon, shapezzLevels } from '#server/utils/shapezz'
import { shapezzPermanentUpgradeCost, shapezzWeaponPrice, shapezzWeaponRefund } from '#shared/shapezz/economy'
import {
    SHAPEZZ_DIFFICULTIES,
    SHAPEZZ_PERMANENT_UPGRADE_IDS,
    SHAPEZZ_PERMANENT_UPGRADES,
    SHAPEZZ_WEAPON_RARITIES,
    SHAPEZZ_WEAPONS,
    shapezzPlayerStats,
    shapezzPower
} from '#shared/shapezz/rules'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const state = getShapezzState(playerId)
    const levels = shapezzLevels(state)
    const arsenal = shapezzArsenal(state)
    const currentWeapon = shapezzEquippedWeapon(state)

    return {
        shards: state.shards,
        levels,
        power: shapezzPower(levels, currentWeapon),
        stats: shapezzPlayerStats(levels),
        currentWeapon,
        weapons: SHAPEZZ_WEAPONS.map((weapon) => {
            const ownedInType = arsenal[weapon.type]
            const rank = SHAPEZZ_WEAPON_RARITIES.indexOf(weapon.rarity)
            const ownedRank = ownedInType.rarity === null ? -1 : SHAPEZZ_WEAPON_RARITIES.indexOf(ownedInType.rarity)
            const cost = shapezzWeaponPrice(weapon.type, weapon.rarity)
            const refund = rank > ownedRank && ownedInType.rarity !== null ? shapezzWeaponRefund(ownedInType.price) : 0
            return {
                ...weapon,
                cost,
                owned: ownedInType.rarity === weapon.rarity,
                // A lower rarity than the one owned is behind you.
                surpassed: rank < ownedRank,
                equipped: weapon.id === currentWeapon.id,
                refund,
                netCost: rank > ownedRank ? cost - refund : 0
            }
        }),
        upgrades: SHAPEZZ_PERMANENT_UPGRADE_IDS.map(id => ({
            id,
            ...SHAPEZZ_PERMANENT_UPGRADES[id],
            level: levels[id],
            cost: shapezzPermanentUpgradeCost(id, levels[id])
        })),
        difficulties: SHAPEZZ_DIFFICULTIES,
        runsPlayed: state.runsPlayed,
        totalShardsEarned: state.totalShardsEarned,
        bestSurvivalMs: state.bestSurvivalMs,
        bestKills: state.bestKills,
        bestCheckpoint: state.bestCheckpoint,
        activeRun: state.runId ? { runId: state.runId } : null
    }
})
