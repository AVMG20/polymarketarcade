import { consumeLaunchToken, verifyLaunchToken } from '#server/utils/launch'
import { upsertPlayer } from '#server/utils/players'
import { setSessionPlayer } from '#server/utils/session'

/** Exchange a hub launch token (`#pnx=…`) for an arcade session. */
export default defineEventHandler(async (event) => {
    const body = await readBody<{ token?: unknown }>(event)
    if (typeof body?.token !== 'string' || body.token.length > 4096) {
        throw createError({ statusCode: 400, statusMessage: 'Missing token' })
    }
    const claims = await verifyLaunchToken(body.token)
    consumeLaunchToken(claims.jti, claims.exp)
    const player = upsertPlayer(claims)
    await setSessionPlayer(event, player.id)
    return { player }
})
