import type { H3Event } from 'h3'
import { sealSession } from 'h3'
import { upsertPlayer } from '../../server/utils/players'
import { SESSION_COOKIE, sessionConfig } from '../../server/utils/session'

let counter = 0

/** A fresh player, as if launched from the hub. */
export function seedPlayer(name = 'Test player') {
    const id = `test-${process.pid}-${Date.now()}-${counter++}`
    upsertPlayer({ sub: id, name, image: null, title: null })
    return id
}

/** A `Cookie` header carrying a sealed arcade session for `playerId`, issued `ageMs` ago. */
export async function sessionCookie(playerId: string, ageMs = 0) {
    const fake = { context: { sessions: { [SESSION_COOKIE]: { id: crypto.randomUUID(), createdAt: Date.now() - ageMs, data: { playerId } } } } }
    return `${SESSION_COOKIE}=${await sealSession(fake as unknown as H3Event, sessionConfig())}`
}
