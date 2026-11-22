import { authorizeSocketUpgrade } from '#server/utils/socket-auth'
import type { PlayerProfile } from '#server/utils/players'
import {
    GRIDWORKS_MAX_PEERS,
    gridworksPeerCount,
    registerGridworksPeer,
    unregisterGridworksPeer,
    type GridworksPeer
} from '#server/utils/gridworks/live'

// Plot invalidation channel: emits { type: 'plot', playerId, layout } after any
// plot changes so open world views refetch it. Authorized in `upgrade`, as in
// polytown/ws.ts.
const sockets = new Map<string, GridworksPeer>()

export default defineWebSocketHandler({
    async upgrade(request) {
        if (gridworksPeerCount() >= GRIDWORKS_MAX_PEERS) return new Response('Too many watchers', { status: 503 })
        const decision = await authorizeSocketUpgrade(request)
        if (decision instanceof Response) return decision
        ;(request as unknown as { context: Record<string, unknown> }).context.player = decision
    },
    open(peer) {
        const player = (peer as unknown as { context: Record<string, unknown> }).context.player as PlayerProfile | undefined
        if (!player) return peer.close(4401, 'Unauthorized')
        const watcher: GridworksPeer = {
            send: data => peer.send(data),
            readyState: () => peer.websocket.readyState
        }
        if (!registerGridworksPeer(watcher, player.id)) return peer.close(4429, 'Too many watchers')
        sockets.set(peer.id, watcher)
    },
    close(peer) {
        const watcher = sockets.get(peer.id)
        if (watcher) unregisterGridworksPeer(watcher)
        sockets.delete(peer.id)
    },
    error(peer) {
        const watcher = sockets.get(peer.id)
        if (watcher) unregisterGridworksPeer(watcher)
        sockets.delete(peer.id)
    }
})
