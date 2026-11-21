import { describe, expect, it } from 'vitest'
import { authorizeSocketUpgrade } from '../server/utils/socket-auth'
import { seedPlayer, sessionCookie } from './setup/players'

function upgrade(headers: Record<string, string>) {
    return authorizeSocketUpgrade({ url: 'http://arcade.test/api/dead-front/ws', headers: new Headers(headers) })
}

describe('socket upgrade auth', () => {
    it('lets a signed-in player in from the arcade\'s own origin', async () => {
        const id = seedPlayer('Sock')
        const result = await upgrade({ origin: 'http://arcade.test', cookie: await sessionCookie(id) })
        expect(result).toMatchObject({ id, name: 'Sock' })
    })

    it('refuses a foreign or missing Origin with 403, even with a valid cookie', async () => {
        const cookie = await sessionCookie(seedPlayer())
        for (const origin of ['https://casino.avmg.nl', 'http://arcade.test.evil.example', 'null']) {
            const result = await upgrade({ origin, cookie })
            expect(result).toBeInstanceOf(Response)
            expect((result as Response).status).toBe(403)
        }
        const missing = await upgrade({ cookie })
        expect((missing as Response).status).toBe(403)
    })

    it('refuses a missing, forged, expired or orphaned session with 401', async () => {
        const origin = 'http://arcade.test'
        const cases: Record<string, string>[] = [
            {},
            { cookie: 'pnx_arcade=not-a-seal' },
            { cookie: await sessionCookie(seedPlayer(), 31 * 86_400_000) },
            { cookie: await sessionCookie('no-such-player') }
        ]
        for (const headers of cases) {
            const result = await upgrade({ origin, ...headers })
            expect(result).toBeInstanceOf(Response)
            expect((result as Response).status).toBe(401)
        }
    })
})
