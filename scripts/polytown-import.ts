// Polytown save migration from the old site (nuxtpolymarket), prepared but
// never run by hand against a live database: it only turns a dump into SQL.
//
//   bun scripts/polytown-import.ts <dump.json> <out.json>
//
// The dump is `{ user_ids, user, town_state, town_storage, town_redesign_drafts,
// town_plots, town_buildings, town_production, town_inventory, town_orders,
// town_trades, town_events, town_contracts, town_contract_days, town_streak }`:
// rows as Postgres `row_to_json` gives them (snake_case, numerics as strings,
// timestamps as ISO strings, jsonb as objects). `town_realm` is ignored.
//
// The output is a JSON array of SQL strings for the arcade's SQLite, each a
// batch of statements of at most 60 KB. Every statement is an INSERT … ON
// CONFLICT DO NOTHING keyed by the old ids, so running the batches again adds
// nothing and never overwrites what a player has done since.
//
// What carries over: buildings, storage, redesign drafts, plots, inventory,
// production history, events, contracts and contract days, the streak, the
// milestones claimed, builders, monument credit and boosts. What does not:
// site coins (towns start at 0 town coins), gems (the hub owns them), and open
// market orders, which are cancelled: a sell order's unfilled goods go back
// into the seller's inventory, a buy order's escrowed site coins are dropped.
// Filled and cancelled orders are not imported either; the trades they made
// are, as price history. Gem rewards still waiting (a streak step locked with
// gems, a contract day's gem bonus) become boosters worth as much.
import { readFileSync, writeFileSync } from 'node:fs'
import { TOWN_BOOSTER_KINDS, townAddBoosters, townBoostersForGems, type TownBoosters } from '../shared/polytown/town-boosts.ts'

type Row = Record<string, unknown>

export interface PolytownDump {
    user_ids: string[]
    user?: Row[]
    town_state?: Row[]
    town_storage?: Row[]
    town_redesign_drafts?: Row[]
    town_plots?: Row[]
    town_buildings?: Row[]
    town_production?: Row[]
    town_inventory?: Row[]
    town_orders?: Row[]
    town_trades?: Row[]
    town_events?: Row[]
    town_contracts?: Row[]
    town_contract_days?: Row[]
    town_streak?: Row[]
}

/** The most one batch of statements may weigh, in bytes. */
export const POLYTOWN_IMPORT_BATCH_BYTES = 60_000

// ─── Values ──────────────────────────────────────────────────────────────────

/** A SQL string literal. */
function text(value: unknown): string {
    if (value === null || value === undefined) return 'NULL'
    return `'${String(value).replace(/'/g, '\'\'')}'`
}

function num(value: unknown, fallback: number | null = 0): string {
    if (value === null || value === undefined || value === '') return fallback === null ? 'NULL' : String(fallback)
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n)) return fallback === null ? 'NULL' : String(fallback)
    return String(n)
}

function int(value: unknown, fallback: number | null = 0): string {
    const n = num(value, fallback)
    return n === 'NULL' ? n : String(Math.trunc(Number(n)))
}

function bool(value: unknown): string {
    return value === true || value === 't' || value === 'true' || value === 1 ? '1' : '0'
}

function json(value: unknown, fallback: unknown): string {
    const parsed = typeof value === 'string' ? safeParse(value) : value
    return text(JSON.stringify(parsed ?? fallback))
}

function safeParse(value: string): unknown {
    try {
        return JSON.parse(value)
    } catch {
        return undefined
    }
}

/**
 * Epoch ms of a Postgres timestamp. The old columns are `timestamp` without a
 * zone, written in UTC, so a bare value is read as UTC; a fraction past
 * milliseconds is cut.
 */
export function timestampMs(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null
    if (typeof value === 'number') return Math.trunc(value)
    let s = String(value).trim().replace(' ', 'T')
    s = s.replace(/(\.\d{3})\d+/, '$1')
    if (!/(Z|[+-]\d{2}(:?\d{2})?)$/.test(s)) s += 'Z'
    const ms = Date.parse(s)
    return Number.isFinite(ms) ? ms : null
}

function ts(value: unknown, fallback: number | null = null): string {
    const ms = timestampMs(value) ?? fallback
    return ms === null ? 'NULL' : String(ms)
}

function insert(table: string, values: Record<string, string>, conflict = ''): string {
    const cols = Object.keys(values)
    return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(c => values[c]).join(', ')}) ON CONFLICT${conflict} DO NOTHING;`
}

// ─── Conversions ─────────────────────────────────────────────────────────────

/** Booster kinds an old reward's boost time (ms per kind) stood for: one each. */
function boostersForBoosts(boosts: unknown): TownBoosters {
    const out: TownBoosters = {}
    if (!boosts || typeof boosts !== 'object') return out
    for (const [kind, ms] of Object.entries(boosts as Record<string, unknown>)) {
        if ((TOWN_BOOSTER_KINDS as readonly string[]).includes(kind) && Number(ms) > 0) out[kind as keyof TownBoosters] = 1
    }
    return out
}

/** A streak step's locked worth with its gems (and old boost time) turned into boosters. */
export function convertStreakLocked(locked: unknown): Record<string, unknown> {
    const source = (typeof locked === 'string' ? safeParse(locked) : locked) as Record<string, Record<string, unknown>> | undefined
    const out: Record<string, unknown> = {}
    for (const [step, entry] of Object.entries(source ?? {})) {
        if (!entry || typeof entry !== 'object') continue
        const reward = entry.reward as Record<string, unknown> | undefined
        if (!reward) {
            out[step] = entry
            continue
        }
        const { gems, boosts, boosters: already, ...rest } = reward
        const boosters = townAddBoosters(townAddBoosters(townBoostersForGems(Number(gems) || 0), boostersForBoosts(boosts)), already as TownBoosters | undefined)
        const extras = Array.isArray(rest.extras)
            ? (rest.extras as Record<string, unknown>[]).map(({ bonusCoins: _bonus, ...extra }) => extra)
            : undefined
        out[step] = {
            ...entry,
            reward: { ...rest, ...(extras ? { extras } : {}), ...(Object.keys(boosters).length ? { boosters } : {}) }
        }
    }
    return out
}

// ─── Build ───────────────────────────────────────────────────────────────────

const byId = (key = 'id') => (a: Row, b: Row) => String(a[key] ?? '').localeCompare(String(b[key] ?? ''))

/** The SQL that imports the dump's towns for `user_ids`, in batches of at most 60 KB. Pure and deterministic. */
export function buildPolytownImport(dump: PolytownDump): string[] {
    const ids = new Set(dump.user_ids)
    const mine = (rows: Row[] | undefined, key = 'user_id') => (rows ?? []).filter(r => ids.has(String(r[key]))).sort(byId())
    const player = (value: unknown) => (value !== null && value !== undefined && ids.has(String(value)) ? text(value) : 'NULL')
    const statements: string[] = []

    // Players first: every Polytown row points at one.
    const names = new Map((dump.user ?? []).map(u => [String(u.id), String(u.name ?? '')]))
    for (const id of [...ids].sort()) {
        statements.push(insert('players', { id: text(id), name: text(names.get(id) || 'Mayor'), origin: text('hub') }, ' (id)'))
    }

    for (const r of mine(dump.town_state).sort(byId('user_id'))) {
        statements.push(insert('polytown_state', {
            player_id: text(r.user_id),
            // The town's coins start at nothing: the old site's coins were the site's, not the town's.
            coins_cents: '0',
            happiness: int(r.happiness, 50),
            tick_progress_ms: int(r.tick_progress_ms),
            last_settled_at: ts(r.last_settled_at, 0),
            plots_bought: int(r.plots_bought, 1),
            last_plot_bought_at: ts(r.last_plot_bought_at, 0),
            milestones_claimed: json(r.milestones_claimed, []),
            coins_earned: num(r.coins_earned),
            produced: json(r.produced, {}),
            builders: int(r.builders, 3),
            carry: json(r.carry, {}),
            monument_credit: json(r.monument_credit, {}),
            build_boost_until: ts(r.build_boost_until),
            production_boost_until: ts(r.production_boost_until),
            temp_builder_until: ts(r.temp_builder_until),
            market_boost_until: ts(r.market_boost_until),
            market_boost_bonus_left: num(r.market_boost_bonus_left),
            boosters: text('{}'),
            created_at: ts(r.created_at, 0)
        }))
    }

    for (const r of mine(dump.town_plots)) {
        statements.push(insert('polytown_plots', {
            id: text(r.id),
            player_id: text(r.user_id),
            x: int(r.x),
            y: int(r.y),
            list_price: num(r.list_price, null),
            paid_price: num(r.paid_price),
            created_at: ts(r.created_at, 0)
        }))
    }

    // A plot the arcade already gave to someone else was skipped above; its
    // buildings go with it rather than failing the run on the foreign key.
    for (const r of mine(dump.town_buildings)) {
        const values: Record<string, string> = {
            id: text(r.id),
            player_id: text(r.user_id),
            plot_id: text(r.plot_id),
            type: text(r.type),
            tile_x: int(r.tile_x),
            tile_y: int(r.tile_y),
            rotation: int(r.rotation),
            level: int(r.level),
            upgrading_to: int(r.upgrading_to, null),
            completes_at: ts(r.completes_at, 0),
            created_at: ts(r.created_at, 0)
        }
        const cols = Object.keys(values)
        statements.push(`INSERT INTO polytown_buildings (${cols.join(', ')}) SELECT ${cols.map(c => values[c]).join(', ')} `
            + `WHERE EXISTS (SELECT 1 FROM polytown_plots WHERE id = ${values.plot_id} AND player_id = ${values.player_id}) ON CONFLICT DO NOTHING;`)
    }

    for (const r of mine(dump.town_storage)) {
        statements.push(insert('polytown_storage', {
            id: text(r.id),
            player_id: text(r.user_id),
            type: text(r.type),
            level: int(r.level),
            upgrading_to: int(r.upgrading_to, null),
            remaining_ms: int(r.remaining_ms),
            created_at: ts(r.created_at, 0),
            stored_at: ts(r.stored_at, 0)
        }))
    }

    for (const r of mine(dump.town_redesign_drafts).sort(byId('user_id'))) {
        statements.push(insert('polytown_redesign_drafts', {
            player_id: text(r.user_id),
            draft: json(r.draft, {}),
            updated_at: ts(r.updated_at, 0)
        }))
    }

    // Inventory, with every open sell order's unfilled goods back on the shelf.
    const stock = new Map<string, number>()
    const shelf = (userId: unknown, resource: unknown) => `${String(userId)}\u0000${String(resource)}`
    for (const r of mine(dump.town_inventory)) stock.set(shelf(r.user_id, r.resource), Number(r.amount) || 0)
    for (const r of mine(dump.town_orders)) {
        if (r.status !== 'open' || r.side !== 'sell') continue
        const left = Math.max(0, (Number(r.quantity) || 0) - (Number(r.filled) || 0))
        const key = shelf(r.user_id, r.resource)
        stock.set(key, (stock.get(key) ?? 0) + left)
    }
    for (const key of [...stock.keys()].sort()) {
        const [userId, resource] = key.split('\u0000') as [string, string]
        statements.push(insert('polytown_inventory', {
            player_id: text(userId),
            resource: text(resource),
            amount: String(Math.max(0, Math.trunc(stock.get(key)!)))
        }))
    }

    for (const r of mine(dump.town_production)) {
        statements.push(insert('polytown_production', {
            id: text(r.id),
            player_id: text(r.user_id),
            resource: text(r.resource),
            amount: int(r.amount),
            from_at: ts(r.from_at, 0),
            to_at: ts(r.to_at, 0)
        }))
    }

    // Trades are the price history every mayor reads; a party who is not
    // being imported is just left out of the row.
    for (const r of [...(dump.town_trades ?? [])].sort(byId())) {
        statements.push(insert('polytown_trades', {
            id: text(r.id),
            resource: text(r.resource),
            buyer_id: player(r.buyer_id),
            seller_id: player(r.seller_id),
            taker_id: player(r.taker_id),
            price: num(r.price),
            quantity: int(r.quantity),
            created_at: ts(r.created_at, 0)
        }))
    }

    for (const r of mine(dump.town_events)) {
        statements.push(insert('polytown_events', {
            id: text(r.id),
            player_id: text(r.user_id),
            kind: text(r.kind),
            data: json(r.data, {}),
            created_at: ts(r.created_at, 0)
        }))
    }

    for (const r of mine(dump.town_contracts)) {
        statements.push(insert('polytown_contracts', {
            id: text(r.id),
            player_id: text(r.user_id),
            day: text(r.day),
            slot: int(r.slot),
            resource: text(r.resource),
            quantity: int(r.quantity),
            reward: num(r.reward),
            delivered: bool(r.delivered),
            delivered_at: ts(r.delivered_at),
            created_at: ts(r.created_at, 0)
        }))
    }

    for (const r of mine(dump.town_contract_days)) {
        statements.push(insert('polytown_contract_days', {
            id: text(r.id),
            player_id: text(r.user_id),
            day: text(r.day),
            // The old gem bonus, as boosters worth as much.
            bonus: text(JSON.stringify(townBoostersForGems(Number(r.bonus_gems) || 0))),
            bonus_claimed: bool(r.bonus_claimed),
            created_at: ts(r.created_at, 0)
        }))
    }

    for (const r of mine(dump.town_streak).sort(byId('user_id'))) {
        statements.push(insert('polytown_streak', {
            player_id: text(r.user_id),
            step: int(r.step),
            last_day: text(r.last_day),
            claimed: int(r.claimed),
            cycle: int(r.cycle),
            locked: text(JSON.stringify(convertStreakLocked(r.locked))),
            lucky: int(r.lucky),
            updated_at: ts(r.updated_at, 0)
        }))
    }

    return batch(statements)
}

/** Statements packed into strings of at most POLYTOWN_IMPORT_BATCH_BYTES, in order. */
function batch(statements: string[]): string[] {
    const out: string[] = []
    let current: string[] = []
    let bytes = 0
    for (const statement of statements) {
        const size = Buffer.byteLength(statement) + 1
        if (size > POLYTOWN_IMPORT_BATCH_BYTES) throw new Error(`One statement is ${size} bytes, over the ${POLYTOWN_IMPORT_BATCH_BYTES} byte batch limit: ${statement.slice(0, 80)}…`)
        if (bytes + size > POLYTOWN_IMPORT_BATCH_BYTES && current.length) {
            out.push(current.join('\n'))
            current = []
            bytes = 0
        }
        current.push(statement)
        bytes += size
    }
    if (current.length) out.push(current.join('\n'))
    return out
}

if (import.meta.main) {
    const [input, output] = process.argv.slice(2)
    if (!input || !output) {
        console.error('Usage: bun scripts/polytown-import.ts <dump.json> <out.json>')
        process.exit(1)
    }
    const dump = JSON.parse(readFileSync(input, 'utf8')) as PolytownDump
    if (!Array.isArray(dump.user_ids)) {
        console.error('The dump needs a user_ids array: who to import')
        process.exit(1)
    }
    const batches = buildPolytownImport(dump)
    writeFileSync(output, `${JSON.stringify(batches, null, 2)}\n`)
    console.log(`${dump.user_ids.length} players → ${batches.length} batch${batches.length === 1 ? '' : 'es'} in ${output}`)
}
