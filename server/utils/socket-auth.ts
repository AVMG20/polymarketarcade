import { arcadeEnv } from './env'
import { findPlayer, type PlayerProfile } from './players'
import { playerIdFromCookieHeader } from './session'

export interface UpgradeRequest {
    url: string
    headers: Headers
}

/**
 * Decide a WebSocket upgrade: the arcade's own pages only (the Origin header
 * must be PUBLIC_URL exactly; SameSite=Lax alone would let any *.avmg.nl page
 * open a socket with the player's cookie), and a valid arcade session for a
 * player that exists. Returns the player, or the refusal to send.
 */
export async function authorizeSocketUpgrade(request: UpgradeRequest): Promise<PlayerProfile | Response> {
    const origin = request.headers.get('origin')
    if (!origin || origin !== arcadeEnv().publicUrl) return new Response('Cross-site socket refused', { status: 403 })
    const playerId = await playerIdFromCookieHeader(request.headers.get('cookie'))
    const player = playerId ? findPlayer(playerId) : undefined
    if (!player) return new Response('Unauthorized', { status: 401 })
    return player
}
