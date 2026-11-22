import { requirePlayerId } from '#server/utils/session'
import { eq } from 'drizzle-orm'
import { db } from '#server/database'
import { polytownPlots } from '#server/database/schema'
import { getWorldView } from '#server/utils/polytown/town'

// Every other mayor in the realm: their plots, what stands on them, and what
// they have listed. Kept out of /api/polytown/state because it is most of the
// bytes and none of it is needed to play your own town.
export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const plots = db.select({ x: polytownPlots.x, y: polytownPlots.y }).from(polytownPlots).where(eq(polytownPlots.playerId, playerId)).all()
    return getWorldView(playerId, plots)
})
