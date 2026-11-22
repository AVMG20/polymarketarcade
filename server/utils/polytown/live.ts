// Connected Polytown watchers. The socket is a pure invalidation channel: after
// a market mutation the server tells every peer which resource book changed
// and clients refetch; no order data travels over the socket itself.
//
// The channel needs a ceiling: without one a client can open sockets until the
// process runs out of memory, and this set is the only thing holding them.
// Past the cap the NEW socket is refused, never an existing one. A browser
// refused here just falls back to its ordinary polling.

export interface TownPeer {
    send: (data: string) => unknown
}

const peers = new Set<TownPeer>()

/** The most sockets this channel will hold at once. */
export const TOWN_MAX_PEERS = 2_000

/** Adds the watcher, or returns false when the channel is already full. */
export function registerTownPeer(peer: TownPeer): boolean {
    if (peers.size >= TOWN_MAX_PEERS) return false
    peers.add(peer)
    return true
}

export function unregisterTownPeer(peer: TownPeer) {
    peers.delete(peer)
}

/** How many watchers are connected. Exposed for the tests and for monitoring. */
export function townPeerCount(): number {
    return peers.size
}

export function broadcastTownMarket(resource: string) {
    const payload = JSON.stringify({ type: 'market', resource, at: Date.now() })
    for (const peer of peers) {
        try {
            peer.send(payload)
        } catch {
            peers.delete(peer)
        }
    }
}
