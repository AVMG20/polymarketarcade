export interface GridworksPeer {
    send(data: string): void
    readyState?: () => number | undefined
}

const peers = new Map<GridworksPeer, string>()
const perPlayer = new Map<string, number>()

export const GRIDWORKS_MAX_PEERS = 2_000
/** A handful of tabs each; one account can't fill the channel. */
export const GRIDWORKS_MAX_PEERS_PER_PLAYER = 6

export function gridworksPeerCount(): number {
    return peers.size
}

export function registerGridworksPeer(peer: GridworksPeer, playerId: string): boolean {
    if (peers.has(peer)) return true
    const mine = perPlayer.get(playerId) ?? 0
    if (peers.size >= GRIDWORKS_MAX_PEERS || mine >= GRIDWORKS_MAX_PEERS_PER_PLAYER) return false
    peers.set(peer, playerId)
    perPlayer.set(playerId, mine + 1)
    return true
}

export function unregisterGridworksPeer(peer: GridworksPeer) {
    const playerId = peers.get(peer)
    if (playerId === undefined) return
    peers.delete(peer)
    const left = (perPlayer.get(playerId) ?? 1) - 1
    if (left > 0) perPlayer.set(playerId, left)
    else perPlayer.delete(playerId)
}

const WS_OPEN = 1

export function broadcastGridworks(playerId: string, layout: number) {
    const payload = JSON.stringify({ type: 'plot', playerId, layout, at: Date.now() })
    for (const peer of [...peers.keys()]) {
        const state = peer.readyState?.()
        if (state !== undefined && state !== WS_OPEN) {
            unregisterGridworksPeer(peer)
            continue
        }
        try {
            peer.send(payload)
        } catch {
            unregisterGridworksPeer(peer)
        }
    }
}
