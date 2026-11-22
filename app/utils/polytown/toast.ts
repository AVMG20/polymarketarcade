import { toast } from 'vue-sonner'

/**
 * The old site's `useToast()` as Polytown called it (`add({ title, color })`),
 * over the arcade's vue-sonner toasts.
 */
export function townToast() {
    return {
        add(opts: { title: string, description?: string, color?: string }) {
            const message = opts.title
            const data = opts.description ? { description: opts.description } : undefined
            if (opts.color === 'error') toast.error(message, data)
            else if (opts.color === 'warning') toast.warning(message, data)
            else toast(message, data)
        }
    }
}
