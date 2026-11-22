# Polynux Arcade

The arcade app of the Polynux platform: four action games ported from the old site (`nuxtpolymarket`):
**Dead Front** (co-op zombies over WebSockets), **SHAPEZZ**, **Pirate Raid** and **Void Runner**
(three.js). The hub (`polymarketcore`, `CORE_URL`) owns accounts, gems and stars;
`docs/platform-contract.md` is the binding contract (a copy of the hub's; change it there and copy it).

**No coins, no gems; one star per game.** The arcade never calls the hub's gem endpoints. Each game declares
one star level (`star` in `shared/games.ts`), a milestone about halfway through it (`shared/stars.ts`);
`server/utils/stars.ts` sends a changed level after the write that earns it, on launch, and for everyone on boot
and hourly, with `star_reports` holding what the hub confirmed. Progression (upgrades, unlocks, saves, ship state) is per player and per game
in the arcade's SQLite, and anything a game used to buy with coins is bought with that game's own currency,
earned by playing it.

## Stack

- Nuxt 4 SPA (`ssr: false`), Vue 3, Tailwind v4, shadcn-vue (`app/components/ui`, generated: don't hand-edit
  beyond imports), `lucide-vue-next`, `vue-sonner`, three.js for the 3D games.
- Fonts are self-hosted `@fontsource/*` packages imported in `app/assets/css/main.css`. The Docker build runs
  `nuxt build` with `--network=none`: no Google Fonts, no CDN, no build-time downloads.
- SQLite through `bun:sqlite` + Drizzle (`server/database/`), migrations in `drizzle/`.
- `jose` for launch tokens, h3 sealed-cookie sessions.
- **bun only** (`bun.lock`). Never npm, pnpm or yarn.

## Runtime: Bun everywhere

Dev, build, tests and production run on Bun (`bun --bun nuxt dev`, `bun --bun nuxt build`, `bun --bun vitest`,
`bun .output/server/index.mjs`), because the database is `bun:sqlite`. The old site moved its dev server to
Node after a per-request TCP leak under Bun; the casino and the hub measured Bun 1.4 / Nuxt 4.5-4.6 and found
it flat. If it comes back, check `lsof -p <dev pid>` for growing sockets and report the versions; don't move
the dev server to Node (bun:sqlite would not load).

## Layout

- `shared/games.ts`: the game registry (lobby and hub manifest). A game is listed only with `ready: true`.
- `shared/utils/random.ts`: CSPRNG helpers (`randomFloat`, `randomInt`, `randomPick`, `randomChance`) and
  `createSeededRandom` for replays and simulations.
- `shared/<game>/`: each game's rules, shared by client and server.
- `server/database/core.ts` (players, launch tokens), `server/database/tables/<game>.ts` (one file per game),
  `schema.ts` re-exports them all. Game tables import from `core.ts`, never from `schema.ts`.
- `server/utils/`: platform: `env.ts` (settings and `configProblems`), `session.ts`, `launch.ts`,
  `players.ts`, `hub.ts` (manifest, ping, stars), `stars.ts`, `manifest.ts`, `same-origin.ts`, `socket-auth.ts`.
  Game logic in `server/utils/<game>/`.
- `server/api/`: `auth/launch`, `auth/logout`, `dev/login`, `config`, `me`, then one folder per game.
  `server/routes/healthz`. `server/plugins/`: `config-check.ts` (production refuses to start
  half-configured), `hub-sync.ts` (manifest on boot, heartbeat). `server/middleware/`: `frame-ancestors`
  (CSP on pages), `same-origin` (refuses cross-site API writes).
- `app/`: `composables/useArcadeSession.ts`, `useHubBridge.ts`; `components/arcade/` (shell and lobby);
  `components/<game>/`, `utils/<game>/` and `pages/<game path>` per game. Game pages use
  `definePageMeta({ layout: 'game' })`: the slim bar, then the game filling the viewport.
- `public/assets/<game>/`: each game's models and music; `public/images/games/` the lobby covers.
- `scripts/`: `migrate.ts` and per-game balance, bench and playtest scripts (`bun scripts/<name>.ts`).

## Games

| Game | Page | Currency (curves) | Server | Notes |
|---|---|---|---|---|
| Dead Front | `/dead-front` | medals, per match from the server sim's own result (`shared/dead-front/progression.ts`) | `server/api/dead-front/ws.ts`, `server/utils/dead-front/` | Co-op over one WebSocket per tab; the sim is authoritative; `dead_front_results` (match, player) applies a result once |
| SHAPEZZ | `/shapezz`, `/shapezz/workshop` | shards, banked at 45 s checkpoints (`shared/shapezz/economy.ts`) | `server/utils/shapezz.ts` | `start-run` issues a run id; `finish-run` settles it once and caps loot by the server clock |
| Pirate Raid | `/pirates`, `/pirates/manage`, `/history`, `/leaderboard` | doubloons, paid by time afloat × sea (`shared/pirate-raid/economy.ts`) | `server/utils/pirate-raid.ts` | Pay comes from the server clock and the difficulty snapshotted at start |
| Void Runner | `/void` | the materials you fly home (`shared/void-runner/economy.ts`) | `server/utils/void-runner.ts` | Hauls are capped by sector, hold and minutes flown; cores by accepted boss kills |

Each game has `scripts/<game>-economy.ts`, a sim that prints runs-to-afford per upgrade tier. Tune the curves
in the shared config and rerun it; values stay plain integers from 1 to a few thousand. Dead Front's scripts
run with `bun --tsconfig-override scripts/tsconfig.bun.json scripts/<name>.ts`.

Static assets live under `public/assets/<game>/`, never `public/<game page>/`: a folder with the same name as a
page makes the static server redirect `/dead-front` to `/dead-front/`.

## Platform

- Launch: the hub frames `{PUBLIC_URL}{path}#pnx=<token>` or redirects through `/connect`; the session
  plugin posts the token to `/api/auth/launch`, which verifies it (ES256, issuer, audience, `jti` once) and
  sets the `pnx_arcade` cookie (`PNX_COOKIE_SAMESITE`, 30 days sliding).
- Protected endpoints start with `const playerId = await requirePlayerId(event)`.
- API writes (non-GET `/api/**`) must come from the arcade's own pages (`server/middleware/same-origin.ts`).
- **WebSockets** (`nitro.experimental.websocket`): authorize in the `upgrade` hook with
  `authorizeSocketUpgrade(request)`: `Origin` must equal `PUBLIC_URL` exactly (else 403), and the cookie must
  unseal to an existing player (else 401). Names and avatars come from the `players` row.
- In the hub iframe (`useHubBridge().embedded`) the app posts `title` (the game's name), `star` (`apiFetch` does
  it for any response with a `star` change) and, when the session runs out, `relaunch`. Never `wallet`.

## Server authority and randomness

- Anything that was anti-cheat on the old site stays server-authoritative: the server validates run results
  against what it issued (run tokens, seeds, caps), and the server rolls drops and rewards.
- Outcomes use `#shared/utils/random` (crypto) on the server. `createSeededRandom` is for simulations that
  must replay (a level layout, a lockstep sim), never for a reward. `Math.random()` only for cosmetics.

## Concurrency (SQLite, one writer)

Assume every endpoint that changes progression gets a burst of parallel requests.

- The mutation is the guard: `UPDATE … WHERE currency >= ? RETURNING`, `INSERT … ON CONFLICT DO NOTHING
  RETURNING`, conditional status flips (`active → finished`). A `SELECT` check followed by an `UPDATE` is
  a bug.
- Read-modify-write runs in `writeTx` (`BEGIN IMMEDIATE`), synchronously: `writeTx` throws if the body
  returns a promise.
- Self-check: if the same request runs twice at once, the second must fail.

## three.js

Test at dpr 1 (a standard 1080p/1440p screen) as well as on a Mac:

- Clamp shader inputs before `pow`, `log` or `sqrt` (`pow(negative, y)` is NaN on Metal and a white blowout
  on D3D). Write `x * x`, not `pow(x, 2.0)`.
- Never render below native resolution at dpr 1: floor the pixel ratio at `min(devicePixelRatio, 1)`, let an
  adaptive scale back off only above that, and derive sizes from the renderer's pixel ratio.
- Give thin lines and point sprites a minimum on-screen size (about 1.5 to 2 px) and dim them by the area
  they gained.

## Client

- `apiFetch<T>(url, options)` / `apiPost<T>(url, body)` for game calls (a 401 relaunches);
  `apiErrorMessage(e, fallback)` for error text; `formatNumber(value, compact = true)` for amounts.
- Toasts are for errors and failures only. No success toasts.
- Minimal text: no explainers, tooltips over sentences.
- Layouts must work at 390 px inside the hub iframe: no horizontal scroll, controls 44 px or larger.

## Code style

- `server/`, `shared/`, `scripts/`, `test/`: 4-space indent. Vue files: 2-space templates, 4-space script.
  Ported game files keep the indent they came with.
- No semicolons, single quotes, no trailing commas, 1tbs braces.

## Workflow

- `bun run typecheck` and `bun run test` must pass before any commit.
- Tests cover rules, correctness and auth. Balance checks and simulations go in `scripts/`, never in tests.
- Schema change: edit the game's `tables/<game>.ts`, `bun run db:generate`, commit the SQL,
  `bun run db:migrate`. Never `drizzle-kit push` in a deploy path. Never wipe anyone's local database.
- Dev server: `bun run dev` on port 3300 (`PNX_DEV_LOGIN=true` gives `/api/dev/login?name=Alice`).
- Commits only when asked; short imperative subject, split by concern.
