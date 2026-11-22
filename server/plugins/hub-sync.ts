import { arcadeEnv } from '#server/utils/env'
import { hub } from '#server/utils/hub'
import { arcadeManifest } from '#server/utils/manifest'
import { syncAllStars } from '#server/utils/stars'

/**
 * Keeps the hub in the loop without ever blocking the arcade on it: push the
 * manifest on boot (retried every minute until accepted), then a heartbeat
 * every ten minutes. Once the manifest is in, star levels the hub doesn't have
 * yet are sent, and again every hour. The games keep working while the hub is down.
 */
const MANIFEST_RETRY_MS = 60_000
const HEARTBEAT_MS = 10 * 60_000
const STAR_SYNC_MS = 60 * 60_000

let manifestAccepted = false

async function pushStars() {
    if (!manifestAccepted) return
    const sent = await syncAllStars().catch((error) => {
        console.warn(`[hub] star sync failed: ${(error as Error).message}`)
        return 0
    })
    if (sent) console.log(`[hub] star levels sent: ${sent}`)
}

async function pushManifest(): Promise<boolean> {
    try {
        const result = await hub.putManifest(arcadeManifest())
        manifestAccepted = true
        console.log(`[hub] manifest accepted: ${result.games.map(game => `${game.slug} (${game.visibility})`).join(', ') || 'no games'}`)
        return true
    } catch (error) {
        console.warn(`[hub] manifest push failed, retrying: ${(error as Error).message}`)
        return false
    }
}

export default defineNitroPlugin(() => {
    if (process.env.VITEST) return
    if (!arcadeEnv().appKey) console.warn('[hub] PNX_APP_KEY is not set: the hub will refuse the manifest')

    void pushManifest().then((accepted) => {
        if (accepted) return void pushStars()
        const retry = setInterval(async () => {
            if (!await pushManifest()) return
            clearInterval(retry)
            void pushStars()
        }, MANIFEST_RETRY_MS)
        retry.unref?.()
    })

    const stars = setInterval(pushStars, STAR_SYNC_MS)
    stars.unref?.()

    const timer = setInterval(() => {
        hub.ping().catch(error => console.warn(`[hub] ping failed: ${(error as Error).message}`))
    }, HEARTBEAT_MS)
    timer.unref?.()
})
