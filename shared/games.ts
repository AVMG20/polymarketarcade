/**
 * The arcade's games: the lobby lists them and the hub manifest declares them.
 * Only games with `ready: true` are listed and declared. Each declares one
 * star level, a milestone about halfway through the game (shared/stars.ts
 * decides it); nothing here earns or costs coins or gems.
 */
export interface ArcadeGame {
    slug: string
    name: string
    tagline: string
    /** Markdown for the hub's game page. */
    description: string
    /** The game's page on the arcade (also the hub's playPath). */
    path: string
    /** A lucide icon name for the hub (`lucide:<name>`). */
    icon: string
    /** Path under public/ for the cover image. */
    cover: string
    accent: string
    /** Multiplayer games say so in the lobby. */
    multiplayer: boolean
    ready: boolean
    /** The game's one star level (key `[a-z0-9-]{1,40}`). */
    star: { key: string, name: string, description: string }
}

const ALL_GAMES: ArcadeGame[] = [
    {
        slug: 'dead-front',
        name: 'Dead Front',
        tagline: 'Co-op zombie rounds in a ruined 1917 chapel',
        description: 'Round-based co-op zombies for up to four players. Find weapons, research perks and see how far your squad gets.',
        path: '/dead-front',
        icon: 'lucide:crosshair',
        cover: '/images/games/dead-front.jpg',
        accent: '#b4532a',
        multiplayer: true,
        ready: true,
        star: { key: 'researcher', name: 'Researcher', description: 'Fully research three perks' }
    },
    {
        slug: 'shapezz',
        name: 'SHAPEZZ',
        tagline: 'Endless platform-shooter mayhem',
        description: 'Jump, shoot and stack mutations. Spend shards in the workshop to come back stronger.',
        path: '/shapezz',
        icon: 'lucide:shapes',
        cover: '/images/games/shapezz.jpg',
        accent: '#e04fd0',
        multiplayer: false,
        ready: true,
        star: { key: 'past-the-wall', name: 'Past the Wall', description: 'Reach checkpoint 10 in one run' }
    },
    {
        slug: 'pirate-raid',
        name: 'Pirate Raid',
        tagline: 'Build a warship and survive the raid',
        description: 'Arm your ship, pick a difficulty and survive a six-minute ocean raid. Doubloons buy cannons, abilities and upgrades.',
        path: '/pirates',
        icon: 'lucide:anchor',
        cover: '/images/games/pirates.jpg',
        accent: '#1f8fbf',
        multiplayer: false,
        ready: true,
        star: { key: 'rough-waters', name: 'Rough Waters', description: 'Survive a full raid at difficulty 500 or higher' }
    },
    {
        slug: 'void-runner',
        name: 'Void Runner',
        tagline: 'Third-person space shooter',
        description: 'Crack ore, fight wardens and build a dreadnought. Everything in the hangar is built from what you fly home.',
        path: '/void',
        icon: 'lucide:rocket',
        cover: '/images/games/void.jpg',
        accent: '#6a5cff',
        multiplayer: false,
        ready: true,
        star: { key: 'cinder-reach', name: 'Cinder Reach', description: 'Clear sector 2: kill its warden and fly home' }
    }
]

export const ARCADE_GAMES: readonly ArcadeGame[] = ALL_GAMES.filter(game => game.ready)

export function findGame(slug: string): ArcadeGame | undefined {
    return ARCADE_GAMES.find(game => game.slug === slug)
}

/** The game a page path belongs to (`/pirates/manage` → Pirate Raid). */
export function gameForPath(path: string): ArcadeGame | undefined {
    return ARCADE_GAMES.find(game => path === game.path || path.startsWith(`${game.path}/`))
}
