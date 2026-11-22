import { ref, watch } from 'vue'
import type { Ref } from 'vue'
import { parseAmount } from '#shared/polytown/parse-amount'

/**
 * Two-way text buffer for a numeric coins ref, so any input can accept
 * shorthand like `10k`, `2.5m` or `1b`. Bind the returned ref with `v-model`
 * on a plain text input (not `type="number"`, which rejects the suffix).
 *
 * Typing updates `amount` as soon as the text parses; blank or unparseable
 * text reads as 0. Setting `amount` from code rewrites the text, but a value
 * the text already means is left alone, so `100m` stays `100m`.
 */
export function useAmountInput(amount: Ref<number>, options: { integer?: boolean, shorthand?: boolean } = {}) {
    const show = (value: number) => (options.shorthand ? amountShorthand(value) : String(value))
    const read = (value: string) => {
        const parsed = parseAmount(value) ?? 0
        return options.integer ? Math.floor(parsed) : parsed
    }

    const text = ref(amount.value ? show(amount.value) : '')

    watch(text, (value) => {
        const parsed = read(value)
        if (parsed !== amount.value) amount.value = parsed
    })

    watch(amount, (value) => {
        if (read(text.value) !== value) text.value = value ? show(value) : ''
    })

    return text
}

/** The shortest `k`/`m`/`b`/`t` spelling that parses back to exactly `value`. */
export function amountShorthand(value: number) {
    const units: [string, number][] = [['t', 1e12], ['b', 1e9], ['m', 1e6], ['k', 1e3]]
    for (const [suffix, size] of units) {
        if (value < size) continue
        const scaled = value / size
        const rounded = Math.round(scaled * 100) / 100
        if (Math.abs(rounded * size - value) < 1e-6) return `${rounded}${suffix}`
    }
    return String(value)
}

/**
 * Full-number readout for shorthand typed into an amount input: `10m` →
 * `10,000,000`. Empty when the text doesn't parse or already reads the same.
 */
export function amountPreview(text: string | undefined, integer = false): string {
    const parsed = parseAmount(text ?? '')
    if (parsed === null) return ''
    const formatted = formatNumber(integer ? Math.floor(parsed) : parsed, false)
    return formatted === text?.trim() ? '' : formatted
}
