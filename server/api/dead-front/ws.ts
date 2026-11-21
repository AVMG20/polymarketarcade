import { applyDfMatchResult, getDfProfile } from '#server/utils/dead-front/profile'
import { DF_MAX_PEERS, useDfHub } from '#server/utils/dead-front/hub'
import type { DfSocket } from '#server/utils/dead-front/hub'
import { authorizeSocketUpgrade } from '#server/utils/socket-auth'
import type { PlayerProfile } from '#server/utils/players'

// Dead Front socket: lobby and match on one connection per tab. The upgrade is
// refused unless it comes from the arcade's own page (Origin) with a valid
// session cookie; the player rides on the socket's context from then on.

const hub = useDfHub(() => ({
    loadProfile: async userId => getDfProfile(userId),
    applyResult: async (userId, result, matchId) => applyDfMatchResult(userId, matchId, result)
}))

interface PeerLike {
    id: string
    context: Record<string, unknown>
    websocket?: SocketLike
    send: (data: unknown) => unknown
    close: (code?: number, reason?: string) => void
}

interface SocketLike {
    bufferedAmount?: unknown
    getBufferedAmount?: () => unknown
}

/** Bytes queued for a peer that stopped reading (a sleeping phone) before it is dropped: ~2 min of snapshots. */
const MAX_BACKLOG = 8 * 1024 * 1024
/** crossws's raw socket (`websocket` is a Proxy that Bun's native methods reject). */
function rawSocket(peer: PeerLike): SocketLike | undefined {
    return (peer as { _internal?: { ws?: SocketLike } })._internal?.ws
}

/**
 * Only a Bun ServerWebSocket's `send` reports a dropped frame (0); crossws's
 * Node adapter (the dev server, even on the Bun runtime) always returns 0.
 */
function isBunSocket(peer: PeerLike): boolean {
    return typeof rawSocket(peer)?.getBufferedAmount === 'function'
}

function backlog(peer: PeerLike): number {
    try {
        const ws = rawSocket(peer) ?? peer.websocket
        // Bun's ServerWebSocket has getBufferedAmount(), Node's ws has bufferedAmount
        const n = typeof ws?.getBufferedAmount === 'function' ? ws.getBufferedAmount() : ws?.bufferedAmount
        return typeof n === 'number' ? n : 0
    } catch {
        return 0
    }
}

function socketOf(peer: PeerLike): DfSocket {
    let closed = false
    const bun = isBunSocket(peer)
    return {
        id: peer.id,
        send: (frame) => {
            if (closed) return
            const sent = peer.send(frame)
            // Bun returns 0 for a frame it dropped (and Node keeps queueing for a peer that stopped
            // reading). A client missing frames silently loses their events, so cut it: it reconnects
            // and resyncs inside the match's grace period.
            if ((bun && sent === 0) || backlog(peer) > MAX_BACKLOG) {
                closed = true
                peer.close(4408, 'Connection too slow')
            }
        },
        close: (code, reason) => peer.close(code, reason),
        backlog: () => backlog(peer)
    }
}

export default defineWebSocketHandler({
    async upgrade(request) {
        if (hub.peerCount >= DF_MAX_PEERS) return new Response('Server full', { status: 503 })
        const decision = await authorizeSocketUpgrade(request)
        if (decision instanceof Response) return decision
        ;(request as unknown as { context: Record<string, unknown> }).context.player = decision
    },

    open(peer) {
        const player = (peer as unknown as PeerLike).context.player as PlayerProfile | undefined
        if (!player) return peer.close(4401, 'Unauthorized')
        hub.open(socketOf(peer as unknown as PeerLike), { id: player.id, name: player.name })
    },

    message(peer, message) {
        hub.message(peer.id, message.text())
    },

    close(peer) {
        hub.close(peer.id)
    },

    error(peer, error) {
        console.error('[dead-front] socket error', peer.id, error)
    }
})
