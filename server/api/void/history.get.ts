import { desc, eq, getTableColumns } from 'drizzle-orm'
import { db } from '#server/database'
import { voidRunHistory } from '#server/database/schema'
import { requirePlayerId } from '#server/utils/session'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    // The audit blob stays on the server: the pilot's history only needs the headline numbers.
    const { meta: _meta, playerId: _player, ...columns } = getTableColumns(voidRunHistory)
    return db.select(columns).from(voidRunHistory)
        .where(eq(voidRunHistory.playerId, playerId))
        .orderBy(desc(voidRunHistory.createdAt))
        .limit(20)
        .all()
})
