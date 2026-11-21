import { arcadeEnv, devLoginAllowed } from '#server/utils/env'

/** What the SPA needs before it has a session: where the hub lives. */
export default defineEventHandler((event) => {
    const env = arcadeEnv()
    return { coreUrl: env.coreUrl, appId: env.appId, devLogin: devLoginAllowed(event) }
})
