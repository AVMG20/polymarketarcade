import { eq } from 'drizzle-orm'
import { db } from '#server/database'
import { players } from '#server/database/schema'

export interface PlayerProfile {
    id: string
    name: string
    image: string | null
    title: string | null
}

/** A player's public profile (name and avatar mirror the hub's launch token), or undefined. */
export function findPlayer(playerId: string): PlayerProfile | undefined {
    return db.select({ id: players.id, name: players.name, image: players.image, title: players.title })
        .from(players).where(eq(players.id, playerId)).get()
}

/** Create the player behind a launch token, or refresh their name, image and title. */
export function upsertPlayer(claims: { sub: string, name: string, image: string | null, title: string | null }, origin: 'hub' | 'dev' = 'hub'): PlayerProfile {
    return db.insert(players)
        .values({ id: claims.sub, name: claims.name, image: claims.image, title: claims.title, origin })
        .onConflictDoUpdate({
            target: players.id,
            set: { name: claims.name, image: claims.image, title: claims.title, updatedAt: new Date() }
        })
        .returning({ id: players.id, name: players.name, image: players.image, title: players.title })
        .get()
}
