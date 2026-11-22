/** The message to show for a failed API call. */
export function apiErrorMessage(error: unknown, fallback = 'Something went wrong'): string {
    const e = error as { data?: { statusMessage?: string, message?: string }, statusMessage?: string, message?: string }
    return e?.data?.statusMessage || e?.data?.message || e?.statusMessage || fallback
}

export function apiStatus(error: unknown): number | undefined {
    const e = error as { statusCode?: number, status?: number, response?: { status?: number } }
    return e?.statusCode ?? e?.status ?? e?.response?.status
}

/**
 * $fetch for game API calls, with the payload type given explicitly. A 401
 * (the session ran out mid-play) relaunches through the hub or /connect and
 * still throws, so the caller stops. A response carrying a new star level
 * (`star: { game, stars }`) is passed on to the hub, which shows the moment.
 */
export async function apiFetch<T>(url: string, options: Parameters<typeof $fetch>[1] = {}): Promise<T> {
    try {
        const result = await $fetch<T>(url, options as never) as T
        const star = (result as { star?: { game?: unknown, stars?: unknown } | null } | null)?.star
        if (star && typeof star.game === 'string' && typeof star.stars === 'number') useHubBridge().postStar(star.game, star.stars)
        return result
    } catch (error) {
        useArcadeSession().handleUnauthorized(error)
        throw error
    }
}

/** POST JSON to a game endpoint. */
export function apiPost<T>(url: string, body: Record<string, unknown> = {}): Promise<T> {
    return apiFetch<T>(url, { method: 'POST', body })
}
