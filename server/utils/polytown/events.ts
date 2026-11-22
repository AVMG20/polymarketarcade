import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { db, type DbExecutor } from '#server/database'
import { polytownEvents } from '#server/database/schema'
import { TOWN_EVENTS_KEEP_MS, TOWN_EVENTS_MAX_PAGE, TOWN_EVENTS_PAGE, type TownEvent, type TownEventData } from '#shared/polytown/town-events'

/**
 * Write one notification. `at` is when the thing happened: a settle that
 * banks a build finished hours ago passes the completion time, so the list
 * reads in the order events occurred rather than the order we noticed them.
 */
export function recordTownEvent(tx: DbExecutor, playerId: string, data: TownEventData, at = Date.now()) {
    tx.insert(polytownEvents).values({ playerId, kind: data.kind, data, createdAt: new Date(at) }).run()
}

/** Drop what nobody will scroll back to. Cheap on the (player, created_at) index. */
export function pruneTownEvents(tx: DbExecutor, playerId: string, now = Date.now()) {
    tx.delete(polytownEvents).where(and(eq(polytownEvents.playerId, playerId), lt(polytownEvents.createdAt, new Date(now - TOWN_EVENTS_KEEP_MS)))).run()
}

/**
 * One page, newest first. `before` is the id of the last event the caller
 * has; the page continues past it. `limit` is capped: an open list reloads
 * everything it shows in one request rather than page by page. The cursor
 * compares (created_at, id) as a row in SQL, so events written in the same
 * millisecond are neither skipped nor repeated.
 */
export function listTownEvents(playerId: string, before: string | null, limit = TOWN_EVENTS_PAGE): { events: TownEvent[], more: boolean } {
    limit = Math.min(TOWN_EVENTS_MAX_PAGE, Math.max(1, Math.floor(limit)))
    const rows = db.select({ id: polytownEvents.id, data: polytownEvents.data, createdAt: polytownEvents.createdAt })
        .from(polytownEvents)
        .where(and(
            eq(polytownEvents.playerId, playerId),
            before
                ? sql`(${polytownEvents.createdAt}, ${polytownEvents.id}) < (select e.created_at, e.id from polytown_events e where e.id = ${before} and e.player_id = ${playerId})`
                : undefined
        ))
        .orderBy(desc(polytownEvents.createdAt), desc(polytownEvents.id))
        .limit(limit + 1)
        .all()
    const page = rows.slice(0, limit)
    return {
        events: page.map(r => ({ id: r.id, data: r.data, at: r.createdAt.getTime() })),
        more: rows.length > limit
    }
}
