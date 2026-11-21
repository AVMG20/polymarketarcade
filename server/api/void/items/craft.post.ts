import { requirePlayerId } from '#server/utils/session'
import { voidCraftItem } from '#server/utils/void-runner'
import { VOID_ITEM_KINDS, type VoidItemKind } from '#shared/void-runner/void-items'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ kind?: unknown, type?: unknown, tier?: unknown }>(event)
    const kind = String(body?.kind) as VoidItemKind
    if (!VOID_ITEM_KINDS.includes(kind)) throw createError({ statusCode: 400, statusMessage: 'Invalid blueprint' })
    return voidCraftItem(playerId, kind, String(body?.type), Number(body?.tier))
})
