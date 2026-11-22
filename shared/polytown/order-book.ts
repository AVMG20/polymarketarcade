// The order-book matcher Polytown's market shares with the old site's gem
// exchange (shared/utils/gamelogic/gem-exchange.ts there), copied as is.

export interface RestingTownOrder {
    id: string
    userId: string
    price: number
    remaining: number
}

export interface TownOrderFill {
    orderId: string
    userId: string
    price: number
    quantity: number
}

/**
 * Match an incoming limit order against the resting book.
 *
 * `book` must be the opposing side sorted best-first (asks: cheapest first,
 * bids: highest first; ties broken oldest first). Fills execute at the RESTING
 * order's price: offer more than a seller asks and you pay their (lower) ask,
 * exactly like the Grand Exchange giving change back. Matching your own
 * resting order is allowed and settles like any other fill, which keeps a
 * forgotten own offer from silently blocking a trade.
 */
export function matchTownOrder(opts: {
    side: 'buy' | 'sell'
    price: number
    quantity: number
    book: RestingTownOrder[]
}): { fills: TownOrderFill[], remaining: number } {
    const fills: TownOrderFill[] = []
    let remaining = opts.quantity

    for (const resting of opts.book) {
        if (remaining <= 0) break
        const crosses = opts.side === 'buy'
            ? resting.price <= opts.price
            : resting.price >= opts.price
        if (!crosses) break
        if (resting.remaining <= 0) continue

        const quantity = Math.min(remaining, resting.remaining)
        fills.push({ orderId: resting.id, userId: resting.userId, price: resting.price, quantity })
        remaining -= quantity
    }

    return { fills, remaining }
}
