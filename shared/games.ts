import { DEAD_FRONT_ICON, PIRATE_RAID_ICON, POLYTOWN_ICON, SHAPEZZ_ICON, VOID_RUNNER_ICON } from './icons'

/**
 * The arcade's games: the lobby lists them and the hub manifest declares them.
 * Only games with `ready: true` are listed and declared. Each declares its
 * star levels (shared/stars.ts decides them): one milestone about halfway
 * through for the action games, five for Polytown.
 */
export interface ArcadeStar {
    key: string
    name: string
    description: string
}

export interface ArcadeGame {
    slug: string
    name: string
    tagline: string
    /** Markdown for the hub's game page. */
    description: string
    /** The game's page on the arcade (also the hub's playPath). */
    path: string
    /** The hub icon: inline SVG (shared/icons.ts). */
    icon: string
    /** Path under public/ for the cover image. */
    cover: string
    accent: string
    /** Multiplayer games say so in the lobby. */
    multiplayer: boolean
    ready: boolean
    /** The game's star levels, level n first-to-last (key `[a-z0-9-]{1,40}`). */
    stars: ArcadeStar[]
}

const ALL_GAMES: ArcadeGame[] = [
    {
        slug: 'dead-front',
        name: 'Dead Front',
        tagline: 'Co-op zombie rounds in a ruined 1917 chapel',
        description: 'Round-based co-op zombies for up to four players. Find weapons, research perks and see how far your squad gets.',
        path: '/dead-front',
        icon: DEAD_FRONT_ICON,
        cover: '/images/games/dead-front.jpg',
        accent: '#b4532a',
        multiplayer: true,
        ready: true,
        stars: [{ key: 'researcher', name: 'Researcher', description: 'Fully research three perks' }]
    },
    {
        slug: 'shapezz',
        name: 'SHAPEZZ',
        tagline: 'Endless platform-shooter mayhem',
        description: 'Jump, shoot and stack mutations. Spend shards in the workshop to come back stronger.',
        path: '/shapezz',
        icon: SHAPEZZ_ICON,
        cover: '/images/games/shapezz.jpg',
        accent: '#e04fd0',
        multiplayer: false,
        ready: true,
        stars: [{ key: 'past-the-wall', name: 'Past the Wall', description: 'Reach checkpoint 10 in one run' }]
    },
    {
        slug: 'pirate-raid',
        name: 'Pirate Raid',
        tagline: 'Build a warship and survive the raid',
        description: 'Arm your ship, pick a difficulty and survive a six-minute ocean raid. Doubloons buy cannons, abilities and upgrades.',
        path: '/pirates',
        icon: PIRATE_RAID_ICON,
        cover: '/images/games/pirates.jpg',
        accent: '#1f8fbf',
        multiplayer: false,
        ready: true,
        stars: [{ key: 'rough-waters', name: 'Rough Waters', description: 'Survive a full raid at difficulty 500 or higher' }]
    },
    {
        slug: 'void-runner',
        name: 'Void Runner',
        tagline: 'Third-person space shooter',
        description: 'Crack ore, fight wardens and build a dreadnought. Everything in the hangar is built from what you fly home.',
        path: '/void',
        icon: VOID_RUNNER_ICON,
        cover: '/images/games/void.jpg',
        accent: '#6a5cff',
        multiplayer: false,
        ready: true,
        stars: [{ key: 'cinder-reach', name: 'Cinder Reach', description: 'Clear sector 2: kill its warden and fly home' }]
    },
    {
        slug: 'polytown',
        name: 'Polytown',
        tagline: 'Grow a town, trade its goods, raise its wonders',
        description: 'Build homes, workshops and roads on your own plots, sell what your town makes or trade it with other mayors, and raise five monuments stage by stage.',
        path: '/polytown',
        icon: POLYTOWN_ICON,
        cover: '/images/games/polytown.jpg',
        accent: '#2a9d8f',
        multiplayer: true,
        ready: true,
        stars: [
            { key: 'cornerstones', name: 'Cornerstones', description: 'Finish 8 monument stages' },
            { key: 'master-mason', name: 'Master Mason', description: 'Finish 16 monument stages' },
            { key: 'wonder-builder', name: 'Wonder Builder', description: 'Finish 24 monument stages' },
            { key: 'skyline', name: 'Skyline', description: 'Finish 32 monument stages' },
            { key: 'wonders-of-the-world', name: 'Wonders of the World', description: 'Finish every stage of all five monuments' }
        ]
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
