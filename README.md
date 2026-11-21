# Polynux Arcade

The arcade app of the Polynux platform: **Dead Front** (co-op zombies), **SHAPEZZ**, **Pirate Raid** and
**Void Runner**. It plugs into the hub (`polymarketcore`) through `docs/platform-contract.md`: players arrive
with a launch token, and the arcade declares its games in a manifest. It holds no coins or gems and sets no
stars: each game keeps its own progression and currency.

Stack: Nuxt 4 (SPA) on Bun, SQLite through `bun:sqlite` + Drizzle, Tailwind v4, shadcn-vue, three.js.

## Setup

```sh
bun install
cp .env.example .env          # then set NUXT_SESSION_PASSWORD to 32+ random characters
bun run db:migrate            # creates ./data/arcade.sqlite
bun run dev                   # http://localhost:3300
```

| | |
|---|---|
| Arcade | `http://localhost:3300` |
| Hub | `http://localhost:3100` (`CORE_URL`) |
| Database | `./data/arcade.sqlite` (`DATABASE_PATH`), WAL mode |
| Health | `GET /healthz` |

With `PNX_DEV_LOGIN=true` (never in production) a signed-out visitor gets a dev login, or go straight to
`http://localhost:3300/api/dev/login?name=Alice`. Dev players never touch the hub.

## Connecting to the hub

Register app `arcade` at the hub (developer API, or an admin) with base URL `http://localhost:3300` and put its
`pnx_` key in `PNX_APP_KEY`. On boot the arcade pushes its manifest (`PUT /api/v1/manifest`, the log says
`[hub] manifest accepted`) and retries every minute while the hub is down. Open
`http://localhost:3100/play/dead-front` signed in at the hub: the hub frames the game with a launch token.
Visiting the arcade directly without a session redirects through `{CORE_URL}/connect`.

## Commands

| | |
|---|---|
| `bun run dev` | Dev server on Bun, port 3300 |
| `bun run build` | Production build (`.output/`) |
| `bun run start` | Serve the build |
| `bun run typecheck` | vue-tsc over app, server, shared, tests and scripts |
| `bun run test` | vitest under Bun (each test file gets its own temporary SQLite file) |
| `bun run db:generate` | New migration from `server/database/schema.ts` |
| `bun run db:migrate` | Apply migrations to `DATABASE_PATH` |
| `bun scripts/<game>-economy.ts` | Runs-to-afford per upgrade tier for one game |

## Production

`docker build -t pnx-arcade .` gives a Bun image that listens on `HOST=0.0.0.0`, `PORT=3000`, keeps the
database at `/data/arcade.sqlite` (mount a volume on `/data`) and runs migrations on every start. Only
`bun install` reaches the network; `nuxt build` runs with `--network=none`.

With `NODE_ENV=production` (set by the image) the config check refuses to start unless `CORE_URL` and
`PUBLIC_URL` are https URLs, `PNX_APP_KEY` is a `pnx_` key and `NUXT_SESSION_PASSWORD` is a fresh secret of 32+
characters. The dev login is off whatever `PNX_DEV_LOGIN` says and the session cookie is always `Secure`. Also
set `PNX_APP_ID=arcade`, `PNX_COOKIE_SAMESITE=lax` and `PNX_DEV_LOGIN=false`. See `.env.example`.

Live: https://arcade.avmg.nl (bitploy project `polynux`, app `arcade`, deploys on every push to `main`).

Dead Front uses a WebSocket at `/api/dead-front/ws` on the same port. The reverse proxy must pass
`Upgrade`/`Connection` through. `PUBLIC_URL` must be the exact origin players load the arcade from: a socket
whose `Origin` differs is refused (403), one without a valid session cookie too (401).

## Docs

- `docs/platform-contract.md`: the contract with the hub (a copy of `polymarketcore`'s).
- `docs/design.md`: theme and UI stack (shared with the hub).
- `docs/frontend-handoff.md`: composables, the shell and what a front-end pass may change.
- `CLAUDE.md`: architecture and conventions.
