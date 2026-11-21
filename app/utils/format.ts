const compactFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 })
const standardFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

/** In-game amounts: 12.3K, 4.56M (compact) or 12,345 (standard). */
export function formatNumber(value: number, compact = true): string {
    if (!Number.isFinite(value)) return '0'
    return (compact ? compactFormat : standardFormat).format(value)
}
