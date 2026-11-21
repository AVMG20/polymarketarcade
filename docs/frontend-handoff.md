# Front-end handoff

The arcade chrome (top bar, lobby, sign-in) is functional and on-theme but plain. Each game keeps its own look
and its own UI inside its page; leave a game's components alone unless the pass is about that game.

## Composables

| | Gives you |
|---|---|
| `useArcadeSession()` | `status` (`loading` / `ready` / `signed-out`), `config` (`coreUrl`, `appId`, `devLogin`), `player` (`id, name, image, title`), `connectUrl()`, `devLogin(name)`, `signOut()`, `handleUnauthorized(error)` |
| `useHubBridge()` | `embedded` (inside the hub iframe), `postTitle(title)`, `relaunch()` |

`apiFetch<T>` / `apiPost<T>` (`app/utils/api.ts`) relaunch on a 401; `apiErrorMessage` gives error text;
`formatNumber` formats amounts.

## Shell (`app/components/arcade/`, `app/layouts/`)

| Piece | Today | For the pass |
|---|---|---|
| `TopBar` | 44 px. Back link (game sub-page → game, game → lobby) or the logo; standalone adds the avatar, name and sign-out. | Keep it slim: inside the hub iframe the hub's own bar shows the player. |
| `GameTile` | Cover (`public/images/games/<cover>.jpg`, screenshots of the ported games), name, tagline, a Co-op badge. | Springy hover is there; drawn covers would lift it. |
| `pages/index.vue` | The lobby: a grid of `ARCADE_GAMES` from `#shared/games`. | The main restyle target. |
| `SignIn` | Hub sign-in, or "Reconnecting" inside the hub; the dev login when it is on. | |
| `layouts/game.vue` | Top bar, then the game filling the rest of the viewport (`h-dvh`, no page scroll). | Games rely on it: keep the box. |

## Constraints

- Works at 390 px inside the hub iframe: no horizontal scroll, controls 44 px or larger. The four games need a
  keyboard and mouse to play; their menus work on a phone.
- Light and dark both work; dark is the default.
- Toasts for errors only. Minimal text: no explainers.
- No coins, gems or stars anywhere in the arcade UI.
