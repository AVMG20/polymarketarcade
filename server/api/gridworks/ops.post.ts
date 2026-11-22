import { requirePlayerId } from '#server/utils/session'
import { notifyPlotChanged, withPlot } from '#server/utils/gridworks/plot'
import { syncStar } from '#server/utils/stars'
import { applyOp, parseOp, type OpError } from '#shared/gridworks/game'

const MAX_OPS = 400
/** A full batch of the largest ops is well under 64 KB. */
const MAX_BYTES = 256 * 1024

// One endpoint for every action: a batch of ops applied in order inside one
// writeTx, after settling to now. Ops that fail are skipped and reported; the
// client replays its own prediction on top of the state it gets back.
export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const tooLarge = () => createError({ statusCode: 413, statusMessage: 'Too many changes at once' })
    if (Number(getRequestHeader(event, 'content-length') ?? 0) > MAX_BYTES) throw tooLarge()
    const raw = await readRawBody(event, false)
    if (raw && raw.length > MAX_BYTES) throw tooLarge()
    let body: { ops?: unknown[] } | null = null
    try {
        body = raw ? JSON.parse(raw.toString('utf8')) : null
    } catch {
        throw createError({ statusCode: 400, statusMessage: 'Bad ops' })
    }
    if (!Array.isArray(body?.ops) || !body.ops.length || body.ops.length > MAX_OPS) {
        throw createError({ statusCode: 400, statusMessage: 'Bad ops' })
    }
    const ops = body.ops.map(parseOp)
    const { state, result: errors, events } = withPlot(playerId, (s, now) => {
        return ops.map((op): OpError | null => op ? applyOp(s, op, now, undefined, playerId) : 'invalid')
    })
    if (errors.some(e => e === null)) notifyPlotChanged(playerId, state.layout)
    const star = await syncStar(playerId, 'gridworks')
    return { state, errors, events, now: Date.now(), star }
})
