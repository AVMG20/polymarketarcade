import { withLockedDfProfile } from '#server/utils/dead-front/profile'
import { dfValidateMods, isDfPerkId } from '#server/utils/dead-front/profile-rules'
import { requirePlayerId } from '#server/utils/session'
import { DF_MAX_PERK_MODS } from '#shared/dead-front/perks'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ perk?: unknown, mods?: unknown }>(event)
    const perk = body?.perk
    const mods = body?.mods
    if (!isDfPerkId(perk)) throw createError({ statusCode: 400, statusMessage: 'Unknown perk' })
    if (!Array.isArray(mods) || mods.length > DF_MAX_PERK_MODS) throw createError({ statusCode: 400, statusMessage: `Pick at most ${DF_MAX_PERK_MODS} modifiers` })
    return withLockedDfProfile(playerId, (view) => {
        const clean = dfValidateMods(perk, mods, view.perkLevels[perk] ?? 0)
        if (clean.length !== mods.length) throw createError({ statusCode: 400, statusMessage: 'That modifier is still locked' })
        const perkMods = { ...view.perkMods }
        if (clean.length) perkMods[perk] = clean
        else delete perkMods[perk]
        const next = { ...view, perkMods }
        return { next, out: next }
    })
})
