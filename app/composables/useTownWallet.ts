/**
 * Polytown's purse: the town's own coins (`balance` on every coin-moving
 * response and on the state) and the player's platform gems, which live at the
 * hub. The old site read both off the session (`useAuth`); here the coins come
 * from the town and the gems from `GET /api/polytown/gems`, every gem spend's
 * response, and the hub's `hello` message. A changed gem count is posted to
 * the hub (`wallet`) so its top bar follows.
 */
export function useTownWallet() {
    const balance = useState<number>('polytown:balance', () => 0)
    const gems = useState<number | null>('polytown:gems', () => null)
    const bridge = useHubBridge()

    const balanceNum = computed(() => balance.value)

    function setBalance(value: number | string | null | undefined) {
        const n = typeof value === 'string' ? parseFloat(value) : value
        if (typeof n === 'number' && Number.isFinite(n)) balance.value = n
    }

    /** A gem balance the hub reported. Posted to the hub's top bar when it changed. */
    function setGems(value: number | null | undefined, post = true) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return
        const changed = gems.value !== value
        gems.value = value
        if (changed && post) bridge.postWallet(value)
    }

    /** Ask the hub (through the arcade) for the gem balance. */
    async function fetchGems() {
        try {
            const res = await apiFetch<{ gems: number | null }>('/api/polytown/gems')
            if (typeof res.gems === 'number') gems.value = res.gems
        } catch {
            // Gems are shown where they are spent; the next spend reports them.
        }
    }

    return { balance, balanceNum, setBalance, gems, setGems, fetchGems, fetchSession: fetchGems }
}

let listening = false

/** Seed the gem count from the hub's `hello` message, once per page. */
export function listenForHubGems() {
    if (listening || !import.meta.client) return
    listening = true
    const { config } = useArcadeSession()
    const { setGems } = useTownWallet()
    window.addEventListener('message', (event) => {
        if (!config.value || event.origin !== config.value.coreUrl) return
        const data = event.data as { source?: unknown, type?: unknown, gems?: unknown } | null
        if (data?.source === 'pnx' && data.type === 'hello' && typeof data.gems === 'number') setGems(data.gems, false)
    })
}
