import { ARCADE_GAMES } from '#shared/games'
import type { HubManifest } from './hub'
import { arcadeEnv } from './env'

export const ARCADE_REPO_URL = 'https://github.com/AVMG20/polymarketarcade'

/** What the arcade declares to the hub: every finished game, with no star levels. */
export function arcadeManifest(): HubManifest {
    const { publicUrl } = arcadeEnv()
    return {
        repoUrl: ARCADE_REPO_URL,
        games: ARCADE_GAMES.map(game => ({
            slug: game.slug,
            visibility: 'public',
            name: game.name,
            tagline: game.tagline,
            description: game.description,
            playPath: game.path,
            icon: game.icon,
            cover: `${publicUrl}${game.cover}`,
            accent: game.accent,
            stars: []
        }))
    }
}
