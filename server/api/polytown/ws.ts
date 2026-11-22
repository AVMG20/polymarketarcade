import { authorizeSocketUpgrade } from '#server/utils/socket-auth'
import { registerTownPeer, TOWN_MAX_PEERS, townPeerCount, unregisterTownPeer, type TownPeer } from '#server/utils/polytown/live'

// Market invalidation channel: emits { type: 'market', resource } after any
// book mutation so open market panels refetch. No order data travels over the
// socket itself. It still needs the arcade's own page and a session: an
// endpoint anyone can open is an endpoint anyone can open two thousand of.

const sockets = new Map<string, TownPeer>()

export default defineWebSocketHandler({
    async upgrade(request) {
        if (townPeerCount() >= TOWN_MAX_PEERS) return new Response('Too many watchers', { status: 503 })
        const decision = await authorizeSocketUpgrade(request)
        if (decision instanceof Response) return decision
        ;(request as unknown as { context: Record<string, unknown> }).context.player = decision
    },
    open(peer) {
        if (!(peer as unknown as { context: Record<string, unknown> }).context.player) return peer.close(4401, 'Unauthorized')
        const watcher: TownPeer = { send: data => peer.send(data) }
        if (!registerTownPeer(watcher)) return peer.close(4429, 'Too many watchers')
        sockets.set(peer.id, watcher)
    },
    close(peer) {
        const watcher = sockets.get(peer.id)
        if (watcher) unregisterTownPeer(watcher)
        sockets.delete(peer.id)
    },
    error(peer) {
        const watcher = sockets.get(peer.id)
        if (watcher) unregisterTownPeer(watcher)
        sockets.delete(peer.id)
    }
})
