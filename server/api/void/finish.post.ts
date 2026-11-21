import { requirePlayerId } from '#server/utils/session'
import { voidFinishRun, type VoidFinishReport } from '#server/utils/void-runner'

const REASONS = ['extracted', 'destroyed', 'abandoned'] as const

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<Record<string, unknown>>(event)
    const reason = REASONS.find(r => r === body?.reason) ?? 'destroyed'
    const report: VoidFinishReport = { ...(body ?? {}), reason }
    return voidFinishRun(playerId, report)
})
