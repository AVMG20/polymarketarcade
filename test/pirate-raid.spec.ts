import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../server/database'
import { pirateCannons, pirateRuns, pirateState } from '../server/database/schema'
import {
    buyPirateAbility, buyPirateSkin, equipPirateAbility, equipPirateSkin, finishPirateRun, fitPirateCannon,
    parsePirateRunReport, pirateLegends, pirateLog, pirateStateView, sellPirateCannon, startPirateRun,
    swapPirateCannons, unlockPirateSlot, upgradePirateAbility, upgradePirateMarque, upgradePirateStat
} from '../server/utils/pirate-raid'
import {
    PIRATE_ABILITY_COSTS, PIRATE_CANNON_COSTS, PIRATE_SKIN_COSTS, pirateAbilityUpgradeCost, pirateCannonCost, pirateCannonTradeIn,
    pirateCompletionBonus, pirateFirstClearBounty, pirateFullTreeCost, pirateMarqueUpgradeCost, pirateSlotUnlockCost,
    pirateStatUpgradeCost, pirateSurvivalPay, pirateVoyagePay
} from '../shared/pirate-raid/economy'
import {
    PIRATE_POWER_UPS, PIRATE_RUN_DURATION_MS, PIRATE_SHIP_STAT_IDS, pirateMaxSelectableDifficulty, pirateNormalizeDifficulty,
    pirateRecommendedDifficulty, pirateRollBoss, pirateRollPowerUp, pirateStatMaxLevel
} from '../shared/pirate-raid/rules'
import { seedPlayer } from './setup/players'

/** A captain with `doubloons` (set directly: test fixture only). */
function captain(doubloons = 0) {
    const id = seedPlayer('Captain')
    pirateStateView(id)
    db.update(pirateState).set({ doubloons }).where(eq(pirateState.playerId, id)).run()
    return id
}

function doubloonsOf(id: string) {
    return db.select({ d: pirateState.doubloons }).from(pirateState).where(eq(pirateState.playerId, id)).get()!.d
}

const fullVoyage = { survived: true, reason: 'timeout' as const, elapsedMs: PIRATE_RUN_DURATION_MS, kills: 40, shotsFired: 300, abandoned: false }

/** Run `fn` against parallel requests; returns how many succeeded. */
async function burst(times: number, fn: () => unknown) {
    const results = await Promise.allSettled(Array.from({ length: times }, async () => fn()))
    return results.filter(r => r.status === 'fulfilled').length
}

describe('pirate rules', () => {
    it('advances the recommended sea in 50-point steps from the first clear', () => {
        expect(pirateRecommendedDifficulty(-1)).toBe(0)
        expect(pirateRecommendedDifficulty(0)).toBe(50)
        expect(pirateRecommendedDifficulty(350)).toBe(400)
        expect(pirateNormalizeDifficulty(374)).toBe(350)
        expect(pirateMaxSelectableDifficulty(40, -1)).toBe(200)
        expect(pirateMaxSelectableDifficulty(500, 350)).toBe(600)
    })

    it('only surfaces the Dreadnought early and never repeats a boss while there is a choice', () => {
        expect(pirateRollBoss(60_000, 0, null).id).toBe('dreadnought')
        for (let i = 0; i < 20; i++) expect(pirateRollBoss(PIRATE_RUN_DURATION_MS, 0, 'kraken').id).not.toBe('kraken')
    })

    it('rolls crates within their stack caps and honours the boss rarity floor', () => {
        const allMaxed = Object.fromEntries(PIRATE_POWER_UPS.map(p => [p.id, p.maxStacks]))
        expect(pirateRollPowerUp(allMaxed)).toBeNull()
        for (let i = 0; i < 30; i++) expect(['epic', 'legendary']).toContain(pirateRollPowerUp({}, 'epic')!.rarity)
        expect(pirateRollPowerUp({ ...allMaxed, 'oak-planking': 0 }, 'epic')!.id).toBe('oak-planking')
    })
})

describe('pirate economy rules', () => {
    it('pays more the longer the ship stays afloat and the harder the sea', () => {
        let last = -1
        for (let ms = 0; ms <= PIRATE_RUN_DURATION_MS; ms += 30_000) {
            const pay = pirateSurvivalPay(ms, 0)
            expect(pay).toBeGreaterThanOrEqual(last)
            last = pay
        }
        expect(pirateSurvivalPay(0, 500)).toBe(0)
        expect(pirateSurvivalPay(PIRATE_RUN_DURATION_MS, 500)).toBeGreaterThan(pirateSurvivalPay(PIRATE_RUN_DURATION_MS, 0))
    })

    it('pays the completion bonus only for a clear, and the first-clear bounty once per difficulty', () => {
        const sunk = pirateVoyagePay(200_000, 100, false, 0, -1)
        expect(sunk.completion).toBe(0)
        expect(sunk.firstClear).toBe(0)
        const first = pirateVoyagePay(PIRATE_RUN_DURATION_MS, 100, true, 0, 50)
        expect(first.completion).toBe(pirateCompletionBonus(100))
        expect(first.firstClear).toBe(pirateFirstClearBounty(100))
        expect(pirateVoyagePay(PIRATE_RUN_DURATION_MS, 100, true, 0, 100).firstClear).toBe(0)
    })

    it('keeps every price and every voyage in small whole numbers', () => {
        const prices: number[] = [...Object.values(PIRATE_CANNON_COSTS), ...Object.values(PIRATE_ABILITY_COSTS), ...Object.values(PIRATE_SKIN_COSTS)]
        for (const stat of PIRATE_SHIP_STAT_IDS) {
            for (let level = 1; level < pirateStatMaxLevel(stat); level++) prices.push(pirateStatUpgradeCost(stat, level)!)
            expect(pirateStatUpgradeCost(stat, pirateStatMaxLevel(stat))).toBeNull()
        }
        for (let slots = 1; slots < 8; slots++) prices.push(pirateSlotUnlockCost(slots)!)
        for (let level = 0; level < 10; level++) prices.push(pirateMarqueUpgradeCost(level)!)
        for (const price of prices) {
            expect(Number.isInteger(price)).toBe(true)
            expect(price).toBeGreaterThanOrEqual(0)
            expect(price).toBeLessThan(5_000)
        }
        expect(pirateVoyagePay(PIRATE_RUN_DURATION_MS, 1000, true, 10, -1).total).toBeLessThan(400)
        expect(Number.isInteger(pirateFullTreeCost())).toBe(true)
    })

    it('climbs: every stat level costs more than the last', () => {
        for (const stat of PIRATE_SHIP_STAT_IDS) {
            for (let level = 2; level < pirateStatMaxLevel(stat); level++) {
                expect(pirateStatUpgradeCost(stat, level)!).toBeGreaterThan(pirateStatUpgradeCost(stat, level - 1)!)
            }
        }
    })
})

describe('finish-run report', () => {
    it('reads the body strictly', () => {
        expect(parsePirateRunReport({ elapsedMs: '360000', survived: 'yes', reason: 'win', kills: 1e9 })).toEqual({
            abandoned: false, survived: false, reason: 'defeat', elapsedMs: 0, kills: 2_000, shotsFired: 0
        })
        expect(parsePirateRunReport(null).reason).toBe('defeat')
    })
})

describe('pirate voyages', () => {
    it('creates a fresh captain with a free swivel gun and nothing to spend', () => {
        const id = seedPlayer()
        const state = pirateStateView(id)
        expect(state.doubloons).toBe(0)
        expect(state.cannons.map(c => c.tierId)).toEqual(['swivel'])
        expect(state.recommendedDifficulty).toBe(0)
        expect(state.activeRun).toBeNull()
        expect(pirateStateView(id).cannons).toHaveLength(1)
    })

    it('refuses a bad difficulty, a sea beyond the ship and a second voyage at sea', () => {
        const id = captain()
        expect(() => startPirateRun(id, '0')).toThrowError(expect.objectContaining({ statusCode: 400 }))
        expect(() => startPirateRun(id, 25)).toThrowError(expect.objectContaining({ statusCode: 400 }))
        expect(() => startPirateRun(id, 1000)).toThrowError(expect.objectContaining({ statusMessage: 'That sea is beyond your ship for now' }))
        startPirateRun(id, 0)
        expect(() => startPirateRun(id, 0)).toThrowError(expect.objectContaining({ statusMessage: 'A voyage is already at sea' }))
    })

    it('needs a cannon to sail', () => {
        const id = captain()
        sellPirateCannon(id, 0)
        expect(() => startPirateRun(id, 0)).toThrowError(expect.objectContaining({ statusCode: 400 }))
    })

    it('caps elapsed time by the server clock, so a fresh voyage cannot claim a full clear', () => {
        const id = captain()
        const now = Date.now()
        startPirateRun(id, 0, now)
        const result = finishPirateRun(id, parsePirateRunReport(fullVoyage), now + 60_000)
        expect(result.elapsedMs).toBe(60_000)
        expect(result.completed).toBe(false)
        expect(result.awarded).toBe(Math.floor(pirateSurvivalPay(60_000, 0)))
    })

    it('pays a full clear with the completion bonus and the first-clear bounty, and saves the progress', () => {
        const id = captain()
        const now = Date.now()
        startPirateRun(id, 0, now)
        const first = finishPirateRun(id, parsePirateRunReport(fullVoyage), now + PIRATE_RUN_DURATION_MS + 500)
        expect(first.completed).toBe(true)
        expect(first.firstClearBounty).toBe(pirateFirstClearBounty(0))
        expect(first.awarded).toBe(first.survivalPay + first.completionBonus + first.firstClearBounty)
        expect(doubloonsOf(id)).toBe(first.awarded)

        startPirateRun(id, 0, now)
        const second = finishPirateRun(id, parsePirateRunReport(fullVoyage), now + PIRATE_RUN_DURATION_MS + 500)
        expect(second.firstClearBounty).toBe(0)

        const state = pirateStateView(id)
        expect(state.runsPlayed).toBe(2)
        expect(state.highestCompletedDifficulty).toBe(0)
        expect(state.recommendedDifficulty).toBe(50)
        expect(state.doubloons).toBe(first.awarded + second.awarded)
        expect(pirateLog(id)).toHaveLength(2)
        expect(pirateLegends(id).find(row => row.isCurrentPlayer)).toMatchObject({ name: 'Captain', difficulty: 0 })
    })

    it('settles a voyage once: a replay and a parallel burst of finishes pay one time', async () => {
        const id = captain()
        const now = Date.now()
        startPirateRun(id, 200, now)
        const paid = await burst(8, () => finishPirateRun(id, parsePirateRunReport(fullVoyage), now + PIRATE_RUN_DURATION_MS))
        expect(paid).toBe(1)
        expect(() => finishPirateRun(id, parsePirateRunReport(fullVoyage), now + PIRATE_RUN_DURATION_MS)).toThrowError(expect.objectContaining({ statusMessage: 'No voyage at sea' }))
        expect(db.select().from(pirateRuns).where(eq(pirateRuns.playerId, id)).all()).toHaveLength(1)
    })

    it('clears an abandoned voyage without paying or counting it', () => {
        const id = captain()
        const now = Date.now()
        startPirateRun(id, 0, now)
        const result = finishPirateRun(id, parsePirateRunReport({ ...fullVoyage, abandoned: true }), now + PIRATE_RUN_DURATION_MS)
        expect(result.awarded).toBe(0)
        const state = pirateStateView(id)
        expect(state.runsPlayed).toBe(0)
        expect(state.activeRun).toBeNull()
        expect(pirateLog(id)).toHaveLength(0)
    })
})

describe('pirate armory', () => {
    it('upgrades a stat for its price and refuses without the doubloons', () => {
        const cost = pirateStatUpgradeCost('hull', 1)!
        const id = captain(cost)
        expect(upgradePirateStat(id, 'hull')).toMatchObject({ level: 2, doubloons: 0 })
        expect(() => upgradePirateStat(id, 'hull')).toThrowError(expect.objectContaining({ statusMessage: 'Not enough doubloons' }))
        expect(() => upgradePirateStat(id, 'luck')).toThrowError(expect.objectContaining({ statusCode: 400 }))
    })

    it('lets only one of a parallel burst of upgrades through when it can afford one', async () => {
        const cost = pirateStatUpgradeCost('speed', 1)!
        const id = captain(cost)
        expect(await burst(10, () => upgradePirateStat(id, 'speed'))).toBe(1)
        expect(pirateStateView(id).levels.speed).toBe(2)
        expect(doubloonsOf(id)).toBe(0)
    })

    it('never double-buys a gun port or a marque level in a burst', async () => {
        const ports = captain(pirateSlotUnlockCost(1)!)
        expect(await burst(6, () => unlockPirateSlot(ports))).toBe(1)
        expect(pirateStateView(ports)).toMatchObject({ cannonSlots: 2, doubloons: 0 })
        const marque = captain(pirateMarqueUpgradeCost(0)!)
        expect(await burst(6, () => upgradePirateMarque(marque))).toBe(1)
        expect(pirateStateView(marque)).toMatchObject({ marque: { level: 1 }, doubloons: 0 })
    })

    it('locks the armory while a voyage is at sea', () => {
        const id = captain(10_000)
        startPirateRun(id, 0)
        expect(() => upgradePirateStat(id, 'hull')).toThrowError(expect.objectContaining({ statusMessage: 'Finish the voyage first' }))
        expect(() => fitPirateCannon(id, 0, 'carronade')).toThrowError(expect.objectContaining({ statusCode: 400 }))
    })

    it('fits a cannon trading the old one in, in one step', () => {
        const id = captain(pirateCannonCost('culverin'))
        fitPirateCannon(id, 0, 'culverin')
        expect(doubloonsOf(id)).toBe(0)
        // Refit with only the trade-in short: the culverin pays half the carronade.
        db.update(pirateState).set({ doubloons: pirateCannonCost('longgun') - pirateCannonTradeIn(pirateCannonCost('culverin')) }).where(eq(pirateState.playerId, id)).run()
        fitPirateCannon(id, 0, 'longgun')
        expect(doubloonsOf(id)).toBe(0)
        expect(pirateStateView(id).cannons).toMatchObject([{ slotIndex: 0, tierId: 'longgun', tradeIn: pirateCannonTradeIn(pirateCannonCost('longgun')) }])
        // A failed refit keeps the old gun.
        expect(() => fitPirateCannon(id, 0, 'leviathan')).toThrowError(expect.objectContaining({ statusMessage: 'Not enough doubloons' }))
        expect(pirateStateView(id).cannons[0]!.tierId).toBe('longgun')
        expect(() => fitPirateCannon(id, 3, 'swivel')).toThrowError(expect.objectContaining({ statusMessage: 'Gun port not open' }))
    })

    it('sells a gun once, even in a burst', async () => {
        const id = captain(pirateCannonCost('basilisk'))
        fitPirateCannon(id, 0, 'basilisk')
        expect(await burst(5, () => sellPirateCannon(id, 0))).toBe(1)
        expect(doubloonsOf(id)).toBe(pirateCannonTradeIn(pirateCannonCost('basilisk')))
        expect(db.select().from(pirateCannons).where(eq(pirateCannons.playerId, id)).all()).toHaveLength(0)
    })

    it('swaps and moves guns between open ports', () => {
        const id = captain(pirateSlotUnlockCost(1)!)
        unlockPirateSlot(id)
        swapPirateCannons(id, 0, 1)
        expect(pirateStateView(id).cannons.map(c => c.slotIndex)).toEqual([1])
        expect(() => swapPirateCannons(id, 0, 0)).toThrowError(expect.objectContaining({ statusCode: 400 }))
    })

    it('unlocks, equips and levels abilities', () => {
        const id = captain(PIRATE_ABILITY_COSTS.tidal! + pirateAbilityUpgradeCost(1)!)
        buyPirateAbility(id, 'tidal')
        expect(pirateStateView(id).equippedAbilityId).toBe('tidal')
        expect(() => buyPirateAbility(id, 'tidal')).toThrowError(expect.objectContaining({ statusMessage: 'Already owned' }))
        expect(() => equipPirateAbility(id, 'seekers')).toThrowError(expect.objectContaining({ statusCode: 400 }))
        equipPirateAbility(id, 'bomb')
        upgradePirateAbility(id, 'bomb')
        const state = pirateStateView(id)
        expect(state.equippedAbilityId).toBe('bomb')
        expect(state.abilities.find(a => a.id === 'bomb')!.level).toBe(2)
        expect(state.doubloons).toBe(0)
    })

    it('sells skins for doubloons and equips owned ones', () => {
        const id = captain(PIRATE_SKIN_COSTS['crimson-privateer']!)
        buyPirateSkin(id, 'crimson-privateer')
        equipPirateSkin(id, 'starter')
        expect(() => equipPirateSkin(id, 'crown-of-tides')).toThrowError(expect.objectContaining({ statusCode: 400 }))
        expect(pirateStateView(id).skins.filter(s => s.owned).map(s => s.id)).toEqual(['starter', 'crimson-privateer'])
    })
})
