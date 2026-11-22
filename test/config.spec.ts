import { afterEach, describe, expect, it } from 'vitest'
import { configProblems } from '../server/utils/env'
import { arcadeManifest } from '../server/utils/manifest'

const saved = { ...process.env }
afterEach(() => {
    process.env = { ...saved }
})

describe('config check', () => {
    it('passes a complete production setup', () => {
        Object.assign(process.env, {
            CORE_URL: 'https://core.avmg.nl',
            PUBLIC_URL: 'https://arcade.avmg.nl',
            PNX_APP_KEY: `pnx_${'a'.repeat(64)}`,
            NUXT_SESSION_PASSWORD: 'x'.repeat(48)
        })
        expect(configProblems()).toEqual([])
    })

    it('names every missing or unsafe setting', () => {
        Object.assign(process.env, {
            CORE_URL: 'http://core.avmg.nl',
            PNX_APP_KEY: '',
            NUXT_SESSION_PASSWORD: 'change-me-to-a-long-random-string-of-32-plus-chars'
        })
        delete process.env.PUBLIC_URL
        const problems = configProblems().join('\n')
        expect(problems).toContain('CORE_URL must be an https URL')
        expect(problems).toContain('PUBLIC_URL is not set')
        expect(problems).toContain('PNX_APP_KEY')
        expect(problems).toContain('NUXT_SESSION_PASSWORD')
    })
})

describe('manifest', () => {
    it('declares only finished games, one star level each and absolute cover URLs', () => {
        const { games } = arcadeManifest()
        for (const game of games) {
            expect(game.slug).toMatch(/^[a-z0-9-]{2,40}$/)
            expect(game.stars).toHaveLength(1)
            expect(game.playPath).toMatch(/^\/[^#\s\\]*$/)
            expect(game.cover).toMatch(/^http:\/\/arcade\.test\//)
            expect(game.accent).toMatch(/^#[0-9a-f]{6}$/i)
            expect(game.icon).toMatch(/^lucide:[a-z0-9-]+$/)
        }
    })
})
