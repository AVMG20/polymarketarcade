/**
 * Talking to the hub when the arcade runs inside its iframe
 * (docs/platform-contract.md, postMessage). The arcade sends `title`, `star`
 * (after the server set a new level), `relaunch`, and `wallet` after Polytown
 * spent platform gems, so the hub's gem chip follows. Outside an iframe every
 * call is a no-op.
 */
export function useHubBridge() {
    const { config } = useArcadeSession()
    const embedded = useState('arcade:embedded', () => import.meta.client && window.self !== window.top)

    function post(type: 'title' | 'star' | 'relaunch' | 'wallet', payload: Record<string, unknown> = {}): boolean {
        if (!embedded.value || !config.value) return false
        window.parent.postMessage({ source: 'pnx', type, ...payload }, config.value.coreUrl)
        return true
    }

    return {
        embedded,
        postTitle: (title: string) => post('title', { title }),
        /** A level the server just set at the hub: the hub refetches the player and shows it. */
        postStar: (game: string, stars: number) => post('star', { game, stars }),
        /** The player's gem balance after a spend (Polytown's gem perks). */
        postWallet: (gems: number) => post('wallet', { gems }),
        /** Ask the hub for a fresh launch (session expired). False when not embedded. */
        relaunch: () => post('relaunch')
    }
}
