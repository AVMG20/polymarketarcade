import { arcadeEnv } from '#server/utils/env'
import { hub } from '#server/utils/hub'
import { arcadeManifest } from '#server/utils/manifest'

/**
 * Keeps the hub in the loop without ever blocking the arcade on it: push the
 * manifest on boot (retried every minute until accepted), then a heartbeat
 * every ten minutes. The games keep working while the hub is down.
 */
const MANIFEST_RETRY_MS = 60_000
const HEARTBEAT_MS = 10 * 60_000

async function pushManifest(): Promise<boolean> {
    try {
        const result = await hub.putManifest(arcadeManifest())
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
        if (accepted) return
        const retry = setInterval(async () => {
            if (await pushManifest()) clearInterval(retry)
        }, MANIFEST_RETRY_MS)
        retry.unref?.()
    })

    const timer = setInterval(() => {
        hub.ping().catch(error => console.warn(`[hub] ping failed: ${(error as Error).message}`))
    }, HEARTBEAT_MS)
    timer.unref?.()
})
