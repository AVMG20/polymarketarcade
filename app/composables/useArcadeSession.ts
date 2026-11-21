import { toast } from 'vue-sonner'

export interface ArcadePlayer {
    id: string
    name: string
    image: string | null
    title: string | null
}

export interface ArcadeConfig {
    coreUrl: string
    appId: string
    devLogin: boolean
}

type Status = 'loading' | 'ready' | 'signed-out'

/**
 * Who is playing. Booted once by the session plugin: a `#pnx=<token>` launch
 * from the hub is exchanged for a session; without a session the player is
 * sent to the hub's /connect (or, with the dev login on, shown the sign-in).
 */
export function useArcadeSession() {
    const status = useState<Status>('arcade:status', () => 'loading')
    const config = useState<ArcadeConfig | null>('arcade:config', () => null)
    const player = useState<ArcadePlayer | null>('arcade:player', () => null)

    function connectUrl() {
        const c = config.value
        if (!c) return '/'
        return `${c.coreUrl}/connect?app=${encodeURIComponent(c.appId)}&return=${encodeURIComponent(window.location.href)}`
    }

    /**
     * The session ran out mid-play. Inside the hub, ask it for a fresh launch;
     * standalone, go through /connect. Returns true when it was a 401.
     */
    function handleUnauthorized(error: unknown): boolean {
        if (apiStatus(error) !== 401) return false
        player.value = null
        status.value = 'signed-out'
        if (useHubBridge().relaunch()) return true
        if (!config.value?.devLogin) window.location.href = connectUrl()
        return true
    }

    async function loadPlayer(): Promise<boolean> {
        try {
            const { player: me } = await $fetch<{ player: ArcadePlayer }>('/api/me')
            player.value = me
            status.value = 'ready'
            return true
        } catch (error) {
            if (apiStatus(error) !== 401) toast.error(apiErrorMessage(error, 'Could not load your account'))
            player.value = null
            return false
        }
    }

    /** Read the launch token from the URL hash (and strip it), or null. */
    function takeLaunchToken(): string | null {
        const match = /(?:^#|&)pnx=([^&]+)/.exec(window.location.hash)
        if (!match) return null
        const rest = window.location.hash.slice(1).split('&').filter(part => !part.startsWith('pnx=')).join('&')
        history.replaceState(history.state, '', window.location.pathname + window.location.search + (rest ? `#${rest}` : ''))
        return decodeURIComponent(match[1]!)
    }

    async function boot() {
        const token = takeLaunchToken()
        config.value = await $fetch<ArcadeConfig>('/api/config')
        if (token) {
            try {
                await $fetch('/api/auth/launch', { method: 'POST', body: { token } })
            } catch (error) {
                toast.error(apiErrorMessage(error, 'Could not sign you in'))
            }
        }
        if (await loadPlayer()) return
        status.value = 'signed-out'
        // Inside the hub, ask it for a fresh launch token (the hub allows one
        // relaunch per 30 s, so a bad token can't loop). Standalone, go through
        // /connect, unless a launch just failed (that would loop) or the dev
        // login screen is on offer.
        if (useHubBridge().relaunch()) return
        if (!token && !config.value.devLogin) window.location.href = connectUrl()
    }

    async function devLogin(name: string) {
        await $fetch('/api/dev/login', { query: { name } })
        await loadPlayer()
    }

    async function signOut() {
        await $fetch('/api/auth/logout', { method: 'POST' })
        player.value = null
        status.value = 'signed-out'
    }

    return { status, config, player, handleUnauthorized, boot, connectUrl, devLogin, signOut }
}
