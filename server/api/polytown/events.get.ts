import { requirePlayerId } from '#server/utils/session'
import { listTownEvents } from '#server/utils/polytown/events'
import { TOWN_EVENTS_PAGE } from '#shared/polytown/town-events'

/**
 * The notification centre, one page at a time. Reading does not settle the
 * town: the state read the client makes on load and every 30 s already
 * banks whatever finished, and this list only needs to be as fresh as that.
 */
export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const { before, limit } = getQuery(event)
    const size = Number(limit)
    return listTownEvents(
        playerId,
        typeof before === 'string' && before ? before : null,
        Number.isFinite(size) && size > 0 ? size : TOWN_EVENTS_PAGE
    )
})
