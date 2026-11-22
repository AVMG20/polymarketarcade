// Polytown timed boosts.
//
// Boosts are stored as boosters (charges) the mayor starts when they choose:
// rewards pay them, and they can be bought with platform gems. Each lasts
// twelve hours, and a second one while the first is running adds another
// twelve on the end.
//
// - Builder's rush: every build job runs at double speed. Jobs already
//   running are shortened the moment it starts; jobs started while it runs
//   are shortened as they start. Either way only the part of the job inside
//   the boost window runs fast.
// - Production surge: production runs at double rate. The settle doubles the
//   part of its window that falls inside the surge.

export type TownBoostKind = 'build' | 'production'

export const TOWN_BOOST_KINDS: readonly TownBoostKind[] = ['build', 'production']

/** How long one boost lasts. */
export const TOWN_BOOST_MS = 12 * 60 * 60_000

/** How much faster things run while a boost is on. */
export const TOWN_BOOST_FACTOR = 2

/** Boost time to add, per kind, in ms. */
export type TownBoostBag = Partial<Record<TownBoostKind, number>>

export function townBoostLabel(kind: TownBoostKind): string {
    return kind === 'build' ? 'Builder\'s rush' : 'Production surge'
}

export function isTownBoostActive(until: number | null | undefined, now: number): boolean {
    return until !== null && until !== undefined && until > now
}

/** The boost's end while it runs, null once it is off. */
export function townBoostUntil(until: number | null | undefined, now: number): number | null {
    return isTownBoostActive(until, now) ? until! : null
}

/** 2 while the boost runs, 1 otherwise. */
export function townBoostMultiplier(until: number | null | undefined, now: number): 1 | 2 {
    return isTownBoostActive(until, now) ? TOWN_BOOST_FACTOR : 1
}

/** Where a boost ends once `ms` more is added: on the end of a running one, or from now. */
export function townBoostExtend(until: number | null | undefined, now: number, ms: number): number {
    return Math.max(now, until ?? 0) + ms
}

/** How much of [start, end] falls before `until`. */
export function townBoostOverlapMs(start: number, end: number, until: number | null | undefined): number {
    if (!until) return 0
    return Math.max(0, Math.min(end, until) - start)
}

/**
 * How long a job of `lengthMs` takes when it starts with `boostMs` of rush
 * left. The job does two ms of work per ms inside the window: a short job
 * finishes inside it in half the time, a long one saves the whole window.
 */
export function townBuildBoostedMs(lengthMs: number, boostMs: number): number {
    if (lengthMs <= 0) return 0
    if (boostMs <= 0) return lengthMs
    return lengthMs <= TOWN_BOOST_FACTOR * boostMs
        ? Math.round(lengthMs / TOWN_BOOST_FACTOR)
        : lengthMs - boostMs * (TOWN_BOOST_FACTOR - 1)
}

/** When a job started at `now` and `lengthMs` long finishes, given the rush running until `boostUntil`. */
export function townBuildBoostedCompletesAt(now: number, lengthMs: number, boostUntil: number | null | undefined): number {
    return now + townBuildBoostedMs(lengthMs, Math.max(0, (boostUntil ?? 0) - now))
}

/**
 * A running job finishing at `completesAt`, with a rush window of `boostMs`
 * laid down from `windowStart`: what is left past the start of the window is
 * shortened, what comes before it is not.
 */
export function townBuildRushedCompletesAt(completesAt: number, windowStart: number, boostMs: number): number {
    if (completesAt <= windowStart) return completesAt
    return windowStart + townBuildBoostedMs(completesAt - windowStart, boostMs)
}

// ─── Free builder ────────────────────────────────────────────────────────────

/** How long a borrowed crew stays. Another one while it is here keeps it twelve hours longer, never two crews. */
export const TOWN_TEMP_BUILDER_MS = 12 * 60 * 60_000

/** Crews the town can put to work: those it owns, plus the borrowed one while it is here. */
export function townCrewCount(owned: number, tempBuilderUntil: number | null | undefined, now: number): number {
    return owned + (isTownBoostActive(tempBuilderUntil, now) ? 1 : 0)
}

// ─── Market day ──────────────────────────────────────────────────────────────

/** How long a market day lasts. */
export const TOWN_MARKET_DAY_MS = 12 * 60 * 60_000

/** What the town hall pays on top of the floor during a market day, as a share of the sale. */
export const TOWN_MARKET_DAY_BONUS = 0.5

/** The town hall's price multiplier right now. */
export function townMarketMultiplier(until: number | null | undefined, now: number): 1 | 1.5 {
    return isTownBoostActive(until, now) ? 1.5 : 1
}

/**
 * Extra coins a town-hall sale of `hallTotal` earns on a market day: half
 * again, but never more than the budget the market days granted. Rounded
 * down to the 4 decimals coins are stored with.
 */
export function townMarketBonus(hallTotal: number, budgetLeft: number, active: boolean): number {
    if (!active || hallTotal <= 0 || budgetLeft <= 0) return 0
    return Math.floor(Math.min(hallTotal * TOWN_MARKET_DAY_BONUS, budgetLeft) * 10_000) / 10_000
}

// ─── Boosters ────────────────────────────────────────────────────────────────
// A booster is one stored boost: rewards pay them and the mayor starts one
// when they choose. Milestones, contracts and the streak used to pay gems on
// the old site; here they pay boosters worth what those gems were, priced by
// TOWN_BOOSTER_WORTH. Boosters can also be bought with platform gems.

export type TownBoosterKind = 'build' | 'production' | 'builder' | 'market'

export const TOWN_BOOSTER_KINDS: readonly TownBoosterKind[] = ['production', 'build', 'builder', 'market']

/** Boosters held or paid, per kind. */
export type TownBoosters = Partial<Record<TownBoosterKind, number>>

export function isTownBoosterKind(kind: unknown): kind is TownBoosterKind {
    return typeof kind === 'string' && (TOWN_BOOSTER_KINDS as readonly string[]).includes(kind)
}

/** How long each booster runs once started. */
export const TOWN_BOOSTER_MS: Record<TownBoosterKind, number> = {
    build: TOWN_BOOST_MS,
    production: TOWN_BOOST_MS,
    builder: TOWN_TEMP_BUILDER_MS,
    market: TOWN_MARKET_DAY_MS
}

export function townBoosterLabel(kind: TownBoosterKind): string {
    switch (kind) {
        case 'build': return 'Builder\'s rush'
        case 'production': return 'Production surge'
        case 'builder': return 'Borrowed crew'
        case 'market': return 'Market day'
    }
}

/** Platform gems one booster costs. */
export const TOWN_BOOSTER_GEM_PRICES: Record<TownBoosterKind, number> = {
    production: 5,
    build: 5,
    builder: 4,
    market: 3
}

/**
 * What one booster is worth in the old site's gems, for turning a gem reward
 * into boosters: a 5-gem goal pays a Production surge, a 10-gem one a surge,
 * a rush and a borrowed crew.
 */
export const TOWN_BOOSTER_WORTH: Record<TownBoosterKind, number> = {
    production: 5,
    build: 3,
    builder: 2,
    market: 1
}

/** The boosters an old gem reward of `gems` pays: the biggest that fit first, then smaller ones for the rest. */
export function townBoostersForGems(gems: number): TownBoosters {
    let left = Math.max(0, Math.floor(gems))
    const out: TownBoosters = {}
    for (const kind of TOWN_BOOSTER_KINDS) {
        const worth = TOWN_BOOSTER_WORTH[kind]
        const n = Math.floor(left / worth)
        if (n > 0) {
            out[kind] = n
            left -= n * worth
        }
    }
    return out
}

/** Two booster bags added up. */
export function townAddBoosters(a: TownBoosters | null | undefined, b: TownBoosters | null | undefined): TownBoosters {
    const out: TownBoosters = {}
    for (const kind of TOWN_BOOSTER_KINDS) {
        const n = Math.max(0, Math.floor(a?.[kind] ?? 0)) + Math.max(0, Math.floor(b?.[kind] ?? 0))
        if (n > 0) out[kind] = n
    }
    return out
}

/** Boosters in a bag, all kinds together. */
export function townBoosterCount(bag: TownBoosters | null | undefined): number {
    return TOWN_BOOSTER_KINDS.reduce((sum, kind) => sum + Math.max(0, Math.floor(bag?.[kind] ?? 0)), 0)
}
