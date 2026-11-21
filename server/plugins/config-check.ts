import { configProblems } from '#server/utils/env'

/**
 * Production refuses to start half-configured: without its public URL the
 * socket Origin check and the manifest covers break, without the hub URL every
 * launch token fails, and a missing key or placeholder session secret would
 * serve players something unsafe.
 */
export default defineNitroPlugin(() => {
    if (process.env.NODE_ENV !== 'production') return
    const problems = configProblems()
    if (problems.length) throw new Error(`[config] refusing to start: ${problems.join('; ')} (see .env.example)`)
})
