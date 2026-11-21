<script setup lang="ts">
import type { InternalApi } from 'nitropack/types'
import { Hexagon, Layers3, Maximize, Minimize, Pause, Play, RotateCcw, Skull, Trophy, Volume2, VolumeX } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { Slider } from '@/components/ui/slider'
import { ShapezzEngine, type ShapezzSnapshot } from '~/utils/shapezz/engine'
import { shapezzIcon } from '~/utils/shapezz/icons'
import { SHAPEZZ_OFFER_DIFFICULTY, shapezzDefeatSalvage, shapezzRunOffer } from '#shared/shapezz/economy'
import {
    SHAPEZZ_CHECKPOINT_MS,
    shapezzBossForCheckpoint,
    shapezzCheckpointPressure,
    shapezzRunUpgrade,
    type ShapezzDifficultyId,
    type ShapezzRunUpgradeId
} from '#shared/shapezz/rules'

type ShapezzState = InternalApi['/api/shapezz/state']['get']
type StartedRun = InternalApi['/api/shapezz/start-run']['post']
type FinishedRun = InternalApi['/api/shapezz/finish-run']['post']

const canvas = ref<HTMLCanvasElement | null>(null)
const arena = ref<HTMLDivElement | null>(null)
const sound = useShapezzSound()
const music = useShapezzMusic()
const { soundEnabled, soundVolume } = sound
const volume = computed({
    get: () => [soundVolume.value],
    set: (value: number[] | undefined) => { soundVolume.value = value?.[0] ?? soundVolume.value }
})

const state = ref<ShapezzState | null>(null)
const selectedDifficultyId = ref<ShapezzDifficultyId>('surge')
const activeDifficultyId = ref<ShapezzDifficultyId>('surge')
const runId = ref<string | null>(null)
const starting = ref(false)
const settling = ref(false)
const running = ref(false)
const paused = ref(false)
const fps = ref(60)
const checkpointOffers = ref<ShapezzRunUpgradeId[]>([])
const emptySnapshot = (): ShapezzSnapshot => ({ hp: 0, maxHp: 1, shield: 0, shieldCapacity: 0, loot: 0, kills: 0, elapsedMs: 0, checkpoint: 0, combo: 0, upgrades: {} })
const snapshot = ref<ShapezzSnapshot>(emptySnapshot())
const result = ref<null | { reason: 'cashout' | 'defeat', awarded: number, elapsedMs: number, kills: number, checkpoint: number }>(null)
const bossWarning = ref('')
const bossTitle = ref('')
let bossWarningTimer: ReturnType<typeof setTimeout> | null = null
let engine: ShapezzEngine | null = null

const hpPercent = computed(() => clampPercent(snapshot.value.hp / Math.max(1, snapshot.value.maxHp) * 100))
const shieldPercent = computed(() => clampPercent(snapshot.value.shield / Math.max(1, snapshot.value.shieldCapacity) * 100))
const nextMutationMs = computed(() => Math.max(0, (snapshot.value.checkpoint + 1) * SHAPEZZ_CHECKPOINT_MS - snapshot.value.elapsedMs))
const activeUpgrades = computed(() => Object.entries(snapshot.value.upgrades)
    .filter((entry): entry is [ShapezzRunUpgradeId, number] => Number(entry[1]) > 0)
    .map(([id, stacks]) => ({ ...shapezzRunUpgrade(id), stacks })))
const currentPressure = computed(() => shapezzCheckpointPressure(snapshot.value.checkpoint))
const bossWaveLabel = computed(() => {
    if (shapezzBossForCheckpoint(snapshot.value.checkpoint)) return 'Boss'
    if (shapezzBossForCheckpoint(snapshot.value.checkpoint + 1)) return 'Boss next'
    return ''
})
// The same calculation the server settles with.
const offer = computed(() => shapezzRunOffer(snapshot.value.loot, snapshot.value.elapsedMs, activeDifficultyId.value))
const salvage = computed(() => shapezzDefeatSalvage(offer.value))

function clampPercent(value: number) {
    return Math.max(0, Math.min(100, value))
}

function formatTime(ms: number) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000))
    return `${Math.floor(totalSeconds / 60)}:${(totalSeconds % 60).toString().padStart(2, '0')}`
}

function rarityClass(id: ShapezzRunUpgradeId) {
    const rarity = shapezzRunUpgrade(id).rarity
    if (rarity === 'cataclysmic') return 'text-fuchsia-300'
    if (rarity === 'unstable') return 'text-amber-300'
    return 'text-cyan-300'
}

// ─── Fullscreen and sound ───────────────────────────────────────────────────

const isFullscreen = ref(false)

async function toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
    else await arena.value?.requestFullscreen().catch(() => {})
}

function onFullscreenChange() {
    isFullscreen.value = document.fullscreenElement === arena.value
}

function toggleSound() {
    soundEnabled.value = !soundEnabled.value
    if (soundEnabled.value) {
        sound.unlock()
        sound.play('pickup-coin')
    }
}

function togglePause() {
    engine?.togglePause()
}

// ─── Runs ───────────────────────────────────────────────────────────────────

async function refresh() {
    try {
        state.value = await apiFetch<ShapezzState>('/api/shapezz/state')
    } catch (error) {
        toast.error(apiErrorMessage(error, 'Could not load SHAPEZZ'))
    }
}

function abandon(id: string) {
    return apiPost('/api/shapezz/finish-run', { runId: id, reason: 'abandoned' })
}

/** A run left open by a closed tab blocks the workshop: release it. */
async function clearStaleRun() {
    const stale = state.value?.activeRun?.runId
    if (!stale) return
    await abandon(stale).catch(() => {})
    await refresh()
}

async function startRun() {
    if (starting.value || !canvas.value || !state.value) return
    starting.value = true
    // A user gesture: the moment to lift the autoplay block.
    sound.unlock()
    sound.preload()
    result.value = null
    checkpointOffers.value = []
    try {
        const run = await apiPost<StartedRun>('/api/shapezz/start-run', { difficultyId: selectedDifficultyId.value })
        if (!canvas.value) {
            void abandon(run.runId).catch(() => {})
            return
        }
        runId.value = run.runId
        activeDifficultyId.value = run.difficulty.id
        engine?.destroy()
        engine = new ShapezzEngine(canvas.value, run.stats, run.weapon, run.difficulty.id, {
            onHud: (value) => { snapshot.value = value },
            onCheckpoint: (offers, value) => {
                snapshot.value = value
                checkpointOffers.value = offers
                sound.play('checkpoint')
            },
            onBoss: (name, title) => {
                bossWarning.value = name
                bossTitle.value = title
                if (bossWarningTimer) clearTimeout(bossWarningTimer)
                bossWarningTimer = setTimeout(() => { bossWarning.value = '' }, 4200)
            },
            onGameOver: (value) => { void settle('defeat', value) },
            onSfx: (event, options) => sound.play(event, options),
            onPause: (value) => { paused.value = value },
            onFps: (value) => { fps.value = value }
        })
        running.value = true
        paused.value = false
        engine.start()
        sound.play('run-start')
        music.play()
    } catch (error) {
        toast.error(apiErrorMessage(error, 'Could not start the run'))
    } finally {
        starting.value = false
    }
}

watch(() => checkpointOffers.value.length > 0, selecting => music.duck(selecting))

function chooseUpgrade(upgradeId: ShapezzRunUpgradeId) {
    if (!engine || settling.value) return
    engine.chooseUpgrade(upgradeId)
    checkpointOffers.value = []
    sound.play('upgrade')
}

function endRun() {
    engine?.destroy()
    engine = null
    running.value = false
    paused.value = false
    checkpointOffers.value = []
    runId.value = null
    music.stop()
}

async function settle(reason: 'cashout' | 'defeat', finalSnapshot: ShapezzSnapshot) {
    if (settling.value || !runId.value) return
    if (reason === 'cashout' && checkpointOffers.value.length === 0) return
    settling.value = true
    try {
        const response = await apiPost<FinishedRun>('/api/shapezz/finish-run', {
            runId: runId.value,
            reason,
            elapsedMs: finalSnapshot.elapsedMs,
            loot: finalSnapshot.loot,
            kills: finalSnapshot.kills
        })
        if (reason === 'cashout') sound.play('cash-out')
        result.value = { reason, awarded: response.awarded, elapsedMs: response.elapsedMs, kills: response.kills, checkpoint: response.checkpoint }
        if (state.value) state.value.shards = response.shards
        endRun()
        await refresh()
    } catch (error) {
        toast.error(apiErrorMessage(error, 'Could not settle the run'))
        if (reason === 'defeat') endRun()
    } finally {
        settling.value = false
    }
}

function cashOut() {
    if (engine) void settle('cashout', engine.getSnapshot())
}

function closeResult() {
    result.value = null
    snapshot.value = emptySnapshot()
}

onMounted(async () => {
    document.addEventListener('fullscreenchange', onFullscreenChange)
    await refresh()
    await clearStaleRun()
})

onUnmounted(() => {
    document.removeEventListener('fullscreenchange', onFullscreenChange)
    if (bossWarningTimer) clearTimeout(bossWarningTimer)
    sound.stop()
    // Leaving mid-run forfeits it; release the lock so the workshop is open.
    const open = runId.value
    endRun()
    if (open) void abandon(open).catch(() => {})
})
</script>

<template>
  <div ref="arena" class="shapezz-arena relative size-full overflow-hidden bg-[#04020f] text-white">
    <!-- The playfield keeps 16:9 and letterboxes inside whatever space it gets. -->
    <div class="absolute inset-0 grid place-items-center [container-type:size]">
      <div class="relative aspect-video w-[min(100cqw,calc(100cqh*16/9))]">
        <canvas ref="canvas" class="absolute inset-0 size-full touch-none" :class="{ 'cursor-none': running }" />
      </div>
    </div>

    <div class="absolute right-2 bottom-2 z-30 flex items-center gap-1.5">
      <div class="flex h-11 items-center gap-2 rounded-lg border border-white/10 bg-black/55 px-1 backdrop-blur-sm">
        <button type="button" class="grid size-9 place-items-center rounded-md hover:bg-white/10" :aria-label="soundEnabled ? 'Mute' : 'Unmute'" @click="toggleSound">
          <Volume2 v-if="soundEnabled" class="size-4 text-cyan-300" />
          <VolumeX v-else class="size-4 text-white/50" />
        </button>
        <Slider v-model="volume" :min="0" :max="100" :disabled="!soundEnabled" class="mr-2 hidden w-24 sm:flex" aria-label="Volume" />
      </div>
      <button type="button" class="grid size-11 place-items-center rounded-lg border border-white/10 bg-black/55 backdrop-blur-sm hover:bg-white/10" :aria-label="isFullscreen ? 'Exit fullscreen' : 'Fullscreen'" @click="toggleFullscreen">
        <Minimize v-if="isFullscreen" class="size-4" />
        <Maximize v-else class="size-4" />
      </button>
    </div>

    <!-- HUD -->
    <div v-if="running" class="pointer-events-none absolute inset-x-0 top-0 z-10 p-2 sm:p-3">
      <div class="flex items-start justify-between gap-2">
        <div class="w-44 max-w-[40vw] rounded-lg border border-white/10 bg-black/55 p-2 backdrop-blur-sm">
          <div class="mb-1 flex justify-between text-[10px] font-black tracking-widest text-white/70 uppercase">
            <span>Hull</span>
            <span class="tabular-nums">{{ Math.ceil(snapshot.hp) }}/{{ snapshot.maxHp }}</span>
          </div>
          <div class="h-2 overflow-hidden rounded-full bg-white/10">
            <div class="h-full bg-emerald-400 shadow-[0_0_14px_#34d399] transition-[width] duration-100" :style="{ width: `${hpPercent}%` }" />
          </div>
          <div v-if="snapshot.shieldCapacity > 0" class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div class="h-full bg-sky-400 shadow-[0_0_14px_#38bdf8] transition-[width] duration-100" :style="{ width: `${shieldPercent}%` }" />
          </div>
        </div>

        <div class="flex items-start gap-1.5">
          <span class="hidden rounded-md border border-white/10 bg-black/55 px-2 py-1 font-mono text-xs font-black text-white/60 tabular-nums sm:block">{{ fps }}</span>
          <div class="shapezz-chip">
            <p class="shapezz-chip-label">Wave</p>
            <p class="shapezz-chip-value">{{ snapshot.checkpoint + 1 }}</p>
            <p v-if="bossWaveLabel" class="text-[9px] font-bold text-fuchsia-300 uppercase">{{ bossWaveLabel }}</p>
          </div>
          <div class="shapezz-chip">
            <p class="shapezz-chip-label">Offer</p>
            <p class="shapezz-chip-value flex items-center justify-center gap-1 text-amber-300"><Hexagon class="size-3.5" />{{ offer }}</p>
          </div>
          <div class="shapezz-chip">
            <p class="shapezz-chip-label">Next</p>
            <p class="shapezz-chip-value text-cyan-300">{{ Math.ceil(nextMutationMs / 1000) }}s</p>
          </div>
          <button
            type="button"
            class="pointer-events-auto grid size-11 place-items-center rounded-lg border border-white/10 bg-black/55 backdrop-blur-sm hover:bg-white/10"
            :aria-label="paused ? 'Resume' : 'Pause'"
            @click="togglePause"
          >
            <Play v-if="paused" class="size-4" />
            <Pause v-else class="size-4" />
          </button>
        </div>
      </div>

      <div class="mt-2 flex items-start justify-between gap-2">
        <div class="flex max-w-[70%] flex-wrap gap-1">
          <div v-for="upgrade in activeUpgrades" :key="upgrade.id" class="flex items-center gap-1 rounded-md border border-white/10 bg-black/50 px-1.5 py-0.5 text-[10px] font-bold text-white/75 backdrop-blur-sm" :title="upgrade.name">
            <component :is="shapezzIcon(upgrade.icon)" class="size-3" :style="{ color: upgrade.accent }" />
            <span class="hidden sm:inline">{{ upgrade.name }}</span>
            <span class="text-white">×{{ upgrade.stacks }}</span>
          </div>
        </div>
        <div v-if="snapshot.combo > 1" class="shapezz-combo text-right text-xl font-black text-amber-300 italic sm:text-4xl">×{{ snapshot.combo }}</div>
      </div>
    </div>

    <div v-if="paused" class="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/70 backdrop-blur-sm">
      <h2 class="text-3xl font-black sm:text-4xl">PAUSED</h2>
      <button type="button" class="shapezz-btn shapezz-btn-primary" @click="togglePause"><Play class="size-4" /> Resume</button>
    </div>

    <Transition name="boss">
      <div v-if="bossWarning" class="pointer-events-none absolute inset-x-0 top-[38%] z-10 text-center">
        <p class="shapezz-boss text-3xl font-black tracking-tight sm:text-5xl">{{ bossWarning }}</p>
        <p class="mt-2 text-sm font-bold text-white/70 italic">{{ bossTitle }}</p>
      </div>
    </Transition>

    <!-- Checkpoint: mutate or bank -->
    <div v-if="checkpointOffers.length" class="absolute inset-0 z-20 overflow-y-auto bg-black/80 p-3 backdrop-blur-md sm:p-6">
      <div class="mx-auto flex min-h-full max-w-5xl flex-col justify-center gap-4">
        <div class="text-center">
          <p class="text-xs font-black tracking-[0.35em] text-fuchsia-300 uppercase">Checkpoint {{ snapshot.checkpoint }}</p>
          <h2 class="mt-1 text-2xl font-black sm:text-4xl">MUTATE OR BANK</h2>
          <p class="mt-1 text-xs text-white/55 tabular-nums" title="Enemy health and damage next round">
            ×{{ currentPressure.health.toFixed(1) }} HP · ×{{ currentPressure.damage.toFixed(1) }} DMG
          </p>
        </div>

        <div class="grid grid-cols-1 gap-2 md:grid-cols-3 md:gap-3">
          <button
            v-for="upgradeId in checkpointOffers"
            :key="upgradeId"
            type="button"
            class="shapezz-upgrade group relative overflow-hidden rounded-xl border border-white/15 bg-white/6 p-3 text-left transition duration-200 hover:-translate-y-1 hover:border-white/40 hover:bg-white/10 sm:p-5"
            :disabled="settling"
            :style="{ '--upgrade-accent': shapezzRunUpgrade(upgradeId).accent }"
            @click="chooseUpgrade(upgradeId)"
          >
            <div class="shapezz-upgrade-bar absolute inset-x-0 top-0 h-1" />
            <div class="flex items-start justify-between gap-3">
              <div class="flex size-10 items-center justify-center rounded-lg border border-white/10 bg-black/35">
                <component :is="shapezzIcon(shapezzRunUpgrade(upgradeId).icon)" class="size-5" :style="{ color: shapezzRunUpgrade(upgradeId).accent }" />
              </div>
              <div class="text-right">
                <p class="text-[9px] font-black tracking-[0.2em] uppercase" :class="rarityClass(upgradeId)">{{ shapezzRunUpgrade(upgradeId).rarity }}</p>
                <p v-if="snapshot.upgrades[upgradeId]" class="mt-1 text-xs font-bold text-white/50">×{{ (snapshot.upgrades[upgradeId] ?? 0) + 1 }}</p>
              </div>
            </div>
            <h3 class="mt-3 text-base font-black sm:text-lg">{{ shapezzRunUpgrade(upgradeId).name }}</h3>
            <p class="mt-1 text-sm leading-snug text-white/65">{{ shapezzRunUpgrade(upgradeId).description }}</p>
            <p class="mt-3 flex items-center gap-1.5 text-xs font-black">
              <Layers3 class="size-3.5" /> {{ shapezzRunUpgrade(upgradeId).stackText }}
            </p>
          </button>
        </div>

        <div class="flex flex-col items-center justify-center gap-2 sm:flex-row sm:gap-4">
          <button type="button" class="shapezz-btn shapezz-btn-gold w-full sm:w-auto" :disabled="settling" @click="cashOut">
            <Hexagon class="size-4" /> Bank {{ offer }}
          </button>
          <p class="text-xs text-white/45 tabular-nums" title="What a defeat keeps"><Skull class="mr-1 inline size-3.5" />{{ salvage }}</p>
        </div>
      </div>
    </div>

    <!-- Menu and results -->
    <div v-else-if="!running" class="absolute inset-0 z-20 flex items-center justify-center overflow-y-auto bg-black/65 p-3 backdrop-blur-sm">
      <div v-if="result" class="shapezz-panel w-full max-w-md">
        <div class="text-center">
          <div class="mx-auto flex size-12 items-center justify-center rounded-2xl" :class="result.reason === 'cashout' ? 'bg-emerald-400/15 text-emerald-300' : 'bg-rose-400/15 text-rose-300'">
            <Trophy v-if="result.reason === 'cashout'" class="size-7" />
            <Skull v-else class="size-7" />
          </div>
          <h2 class="mt-3 text-2xl font-black">{{ result.reason === 'cashout' ? 'BANKED' : 'GEOMETRY WINS' }}</h2>
        </div>
        <div class="mt-4 grid grid-cols-3 gap-2">
          <div class="shapezz-stat"><p class="shapezz-stat-label">Shards</p><p class="flex items-center justify-center gap-1 font-black text-amber-300"><Hexagon class="size-3.5" />{{ result.awarded }}</p></div>
          <div class="shapezz-stat"><p class="shapezz-stat-label">Time</p><p class="font-black tabular-nums">{{ formatTime(result.elapsedMs) }}</p></div>
          <div class="shapezz-stat"><p class="shapezz-stat-label">Kills</p><p class="font-black tabular-nums">{{ result.kills }}</p></div>
        </div>
        <button type="button" class="shapezz-btn shapezz-btn-primary mt-4 w-full" @click="closeResult"><RotateCcw class="size-4" /> Again</button>
      </div>

      <div v-else-if="state" class="shapezz-panel w-full max-w-xl">
        <h2 class="shapezz-title text-center text-3xl font-black tracking-[-0.06em] sm:text-4xl">SHAPEZZ</h2>

        <div class="mt-4 grid grid-cols-3 gap-1.5 sm:grid-cols-5" role="radiogroup" aria-label="Difficulty">
          <button
            v-for="difficulty in state.difficulties"
            :key="difficulty.id"
            type="button"
            role="radio"
            :aria-checked="selectedDifficultyId === difficulty.id"
            class="flex min-h-14 min-w-0 flex-col items-center justify-center rounded-lg border px-1 py-2 text-center transition"
            :class="selectedDifficultyId === difficulty.id ? 'bg-white/12' : 'border-white/10 bg-white/4 hover:bg-white/8'"
            :style="selectedDifficultyId === difficulty.id ? { borderColor: difficulty.color } : undefined"
            :title="difficulty.tagline"
            @click="selectedDifficultyId = difficulty.id"
          >
            <span class="w-full truncate text-[11px] font-black uppercase sm:text-xs" :style="{ color: difficulty.color }">{{ difficulty.name }}</span>
            <span class="text-[10px] font-bold text-white/55 tabular-nums" title="Shards">×{{ SHAPEZZ_OFFER_DIFFICULTY[difficulty.id] }}</span>
          </button>
        </div>

        <div class="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
          <div class="shapezz-stat min-w-0"><p class="shapezz-stat-label">Weapon</p><p class="truncate font-black" :style="{ color: state.currentWeapon.primaryColor }">{{ state.currentWeapon.name }}</p></div>
          <div class="shapezz-stat"><p class="shapezz-stat-label">Damage</p><p class="font-black tabular-nums">{{ Math.round(state.stats.damage * state.currentWeapon.damageMultiplier) }}</p></div>
          <div class="shapezz-stat"><p class="shapezz-stat-label">Hull</p><p class="font-black tabular-nums">{{ state.stats.maxHp }}</p></div>
        </div>

        <div class="mt-3 flex items-center justify-center gap-4 text-xs text-white/60 tabular-nums">
          <span class="flex items-center gap-1" title="Shards"><Hexagon class="size-3.5 text-amber-300" />{{ state.shards }}</span>
          <span class="flex items-center gap-1" title="Best run"><Trophy class="size-3.5" />{{ formatTime(state.bestSurvivalMs) }}</span>
        </div>

        <button type="button" class="shapezz-btn shapezz-btn-primary mt-4 w-full" :disabled="starting" @click="startRun">
          <Play class="size-4" /> START
        </button>
        <p class="mt-3 hidden text-center text-[11px] text-white/40 sm:block">WASD · Space jump · S drop · Mouse aim · Hold click fire · P pause</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shapezz-arena {
    box-shadow: inset 0 0 90px rgb(0 0 0 / 70%);
}

.shapezz-title {
    text-shadow: 0 0 24px rgb(34 211 238 / 55%), 0 0 60px rgb(232 121 249 / 35%);
}

.shapezz-panel {
    border: 1px solid rgb(255 255 255 / 12%);
    border-radius: 1rem;
    padding: 1.25rem;
    background: rgb(10 8 34 / 92%);
    box-shadow: 0 30px 80px rgb(0 0 0 / 55%);
}

.shapezz-chip {
    border: 1px solid rgb(255 255 255 / 10%);
    border-radius: 0.5rem;
    padding: 0.35rem 0.6rem;
    text-align: center;
    background: rgb(0 0 0 / 55%);
    backdrop-filter: blur(4px);
}

.shapezz-chip-label {
    font-size: 9px;
    font-weight: 900;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: rgb(255 255 255 / 50%);
}

.shapezz-chip-value {
    font-size: 1rem;
    font-weight: 900;
    font-variant-numeric: tabular-nums;
}

.shapezz-stat {
    border-radius: 0.5rem;
    padding: 0.6rem;
    text-align: center;
    background: rgb(255 255 255 / 6%);
}

.shapezz-stat-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    color: rgb(255 255 255 / 50%);
}

.shapezz-btn {
    display: inline-flex;
    min-height: 2.75rem;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0 1.25rem;
    font-weight: 900;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-variant-numeric: tabular-nums;
    clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
    transition: filter 0.15s ease;
}

.shapezz-btn:hover:not(:disabled) {
    filter: brightness(1.15);
}

.shapezz-btn:disabled {
    cursor: not-allowed;
    opacity: 0.5;
}

.shapezz-btn-primary {
    color: #04020f;
    background: linear-gradient(90deg, #22d3ee, #a78bfa);
}

.shapezz-btn-gold {
    color: #1a1204;
    background: linear-gradient(90deg, #fbbf24, #f59e0b);
}

.shapezz-combo {
    text-shadow: 0 0 18px rgb(250 204 21 / 70%);
    animation: combo-pulse 0.45s ease-in-out infinite alternate;
}

.shapezz-boss {
    text-shadow: 0 0 30px rgb(232 121 249 / 85%);
}

.shapezz-upgrade-bar {
    background: var(--upgrade-accent);
    box-shadow: 0 0 24px var(--upgrade-accent);
}

.shapezz-upgrade::after {
    position: absolute;
    inset: 0;
    pointer-events: none;
    content: '';
    opacity: 0;
    background: radial-gradient(circle at 50% 0%, color-mix(in srgb, var(--upgrade-accent) 24%, transparent), transparent 65%);
    transition: opacity 180ms ease;
}

.shapezz-upgrade:hover::after {
    opacity: 1;
}

.boss-enter-active,
.boss-leave-active {
    transition: all 300ms ease;
}

.boss-enter-from,
.boss-leave-to {
    opacity: 0;
    transform: scale(1.35);
}

@keyframes combo-pulse {
    from { transform: scale(0.96) rotate(-1deg); }
    to { transform: scale(1.04) rotate(1deg); }
}

@media (prefers-reduced-motion: reduce) {
    .shapezz-combo {
        animation: none;
    }
}
</style>
