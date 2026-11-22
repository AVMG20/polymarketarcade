import { FetchError, ofetch } from 'ofetch'
import { arcadeEnv } from './env'

/**
 * Client for the hub's app API (docs/platform-contract.md §2). The arcade
 * declares its games, sends heartbeats and sets star levels, and Polytown
 * spends (and refunds) platform gems for its perks; the arcade never creates
 * gems. Every call carries the app's Bearer key and gives up after a few
 * seconds, so a slow hub never holds an arcade request hostage.
 */

const TIMEOUT_MS = 5_000

export class HubError extends Error {
    /** `statusCode` is null when the hub could not be reached at all. */
    constructor(message: string, readonly statusCode: number | null) {
        super(message)
        this.name = 'HubError'
    }
}

export interface HubManifestGame {
    slug: string
    visibility: 'public' | 'draft'
    name: string
    tagline: string
    description: string
    playPath: string
    icon: string
    cover: string | null
    accent: string
    stars: { key: string, name: string, description: string }[]
}

export interface HubManifest {
    /** Where the app's code lives; the hub links it from the game pages. */
    repoUrl?: string | null
    games: HubManifestGame[]
}

async function request<T>(method: 'GET' | 'PUT' | 'POST', path: string, body?: Record<string, unknown>): Promise<T> {
    const env = arcadeEnv()
    try {
        return await ofetch<T>(`${env.coreUrl}/api/v1${path}`, {
            method,
            body,
            headers: { Authorization: `Bearer ${env.appKey}` },
            timeout: TIMEOUT_MS,
            retry: 0
        })
    } catch (error) {
        if (error instanceof FetchError) {
            const data = error.data as { statusMessage?: string, message?: string } | undefined
            throw new HubError(data?.statusMessage || data?.message || error.message, error.statusCode ?? error.response?.status ?? null)
        }
        throw new HubError(error instanceof Error ? error.message : 'Hub request failed', null)
    }
}

export const hub = {
    putManifest: (manifest: HubManifest) =>
        request<{ games: { slug: string, stars: number, visibility: string }[] }>('PUT', '/manifest', manifest as unknown as Record<string, unknown>),

    setStars: (input: { playerId: string, game: string, stars: number, seq: number }) =>
        request<{ applied: boolean, stars: number, best: number, bounty: number, total: number, title: string }>('PUT', '/stars', input),

    /** Heartbeat: tells the hub this app is alive. */
    ping: () => request<unknown>('GET', '/ping'),

    /** A connected player's profile and gem balance (403 for a player who never connected). */
    getPlayer: (playerId: string) =>
        request<{ id: string, name: string, image: string | null, gems: number, stars: number, title: string }>('GET', `/players/${encodeURIComponent(playerId)}`)
}

export interface GemSpend {
    /** One key per purchase, 8..100 chars; a retry with the same key is charged once. */
    idempotencyKey: string
    playerId: string
    amount: number
    game: string
    reason: string
}

/**
 * Burn `amount` of the player's platform gems (contract §2 `POST /gems/spend`).
 * 400 when they can't afford it; a replayed key returns the original spend.
 */
export function spendGems(input: GemSpend): Promise<{ spendId: string, gems: number }> {
    return request<{ spendId: string, gems: number }>('POST', '/gems/spend', { ...input })
}

/** Give back one of this app's spends, within 24 h and once (contract §2 `POST /gems/refund`). */
export function refundGems(spendId: string): Promise<{ gems: number }> {
    return request<{ gems: number }>('POST', '/gems/refund', { spendId })
}
