import type { H3Event } from 'h3'
import { getRequestHost, getRequestProtocol } from 'h3'

/**
 * Arcade settings, read from the environment on every call so tests and a
 * restarted container see the current values. Names follow .env.example.
 */
export function arcadeEnv() {
    const production = process.env.NODE_ENV === 'production'
    return {
        coreUrl: (process.env.CORE_URL || 'http://localhost:3100').replace(/\/+$/, ''),
        appId: process.env.PNX_APP_ID || 'arcade',
        appKey: process.env.PNX_APP_KEY || '',
        sessionPassword: process.env.NUXT_SESSION_PASSWORD || '',
        sameSite: process.env.PNX_COOKIE_SAMESITE === 'none' ? 'none' as const : 'lax' as const,
        production,
        publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3300').replace(/\/+$/, ''),
        devLoginFlag: !production && process.env.PNX_DEV_LOGIN === 'true'
    }
}

export type ArcadeEnv = ReturnType<typeof arcadeEnv>

/** The session password placeholder from .env.example: long enough, but public. */
export const PLACEHOLDER_PASSWORD_PREFIX = 'change-me'

/**
 * What is wrong with the configuration for production, or an empty list.
 * The config-check plugin refuses to start with any of these.
 */
export function configProblems(env: ArcadeEnv = arcadeEnv()): string[] {
    const problems: string[] = []
    const httpsUrl = (name: string, value: string | undefined) => {
        if (!value) return problems.push(`${name} is not set`)
        try {
            if (new URL(value).protocol !== 'https:') problems.push(`${name} must be an https URL`)
        } catch {
            problems.push(`${name} is not a URL`)
        }
    }
    httpsUrl('CORE_URL', process.env.CORE_URL)
    httpsUrl('PUBLIC_URL', process.env.PUBLIC_URL)
    if (!/^pnx_[A-Za-z0-9_-]{16,}$/.test(env.appKey)) problems.push('PNX_APP_KEY must be the app\'s pnx_ key')
    if (env.sessionPassword.length < 32 || env.sessionPassword.startsWith(PLACEHOLDER_PASSWORD_PREFIX)) {
        problems.push('NUXT_SESSION_PASSWORD must be a fresh secret of at least 32 characters')
    }
    return problems
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * The dev login is open only outside production, with PNX_DEV_LOGIN=true, and
 * for a request on plain http or a localhost host. A mis-set env var on a
 * public https deployment still can't enable it.
 */
export function devLoginAllowed(event: H3Event): boolean {
    if (!arcadeEnv().devLoginFlag) return false
    const host = getRequestHost(event, { xForwardedHost: true }).replace(/:\d+$/, '')
    return LOCAL_HOSTS.has(host) || getRequestProtocol(event, { xForwardedProto: true }) === 'http'
}
