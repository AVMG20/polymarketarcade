import { FetchError, ofetch } from 'ofetch'
import { arcadeEnv } from './env'

/**
 * Client for the hub's app API (docs/platform-contract.md §2). The arcade
 * declares its games, sends heartbeats and sets star levels; it holds no gems. Every call carries the app's Bearer key and gives up after a few
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

async function request<T>(method: 'GET' | 'PUT', path: string, body?: Record<string, unknown>): Promise<T> {
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
    ping: () => request<unknown>('GET', '/ping')
}
