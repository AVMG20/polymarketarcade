/**
 * Talking to the hub when the arcade runs inside its iframe
 * (docs/platform-contract.md, postMessage). The arcade holds no gems, so it
 * sends `title`, `star` (after the server set a new level) and `relaunch`.
 * Outside an iframe every call is a no-op.
 */
export function useHubBridge() {
    const { config } = useArcadeSession()
    const embedded = useState('arcade:embedded', () => import.meta.client && window.self !== window.top)

    function post(type: 'title' | 'star' | 'relaunch', payload: Record<string, unknown> = {}): boolean {
        if (!embedded.value || !config.value) return false
        window.parent.postMessage({ source: 'pnx', type, ...payload }, config.value.coreUrl)
        return true
    }

    return {
        embedded,
        postTitle: (title: string) => post('title', { title }),
        /** A level the server just set at the hub: the hub refetches the player and shows it. */
        postStar: (game: string, stars: number) => post('star', { game, stars }),
        /** Ask the hub for a fresh launch (session expired). False when not embedded. */
        relaunch: () => post('relaunch')
    }
}
