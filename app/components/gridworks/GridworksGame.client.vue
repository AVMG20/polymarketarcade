<script setup lang="ts">
import {
    ArrowRight, ArrowUpCircle, ChevronDown, ChevronUp, Factory, FlaskConical, Home, Keyboard,
    LoaderCircle, Moon, MousePointer2, Package, RotateCw, Route, Sun, Trash2, Volume2, VolumeX, X, Zap
} from 'lucide-vue-next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { BUILDINGS, ITEMS, ITEM_IDS, RECIPES, RESEARCH_BY_ID, isUnlocked, maxMk, upgradeCost, type Category, type ItemId, type Kind, type Stock } from '#shared/gridworks/defs'
import { canAfford } from '#shared/gridworks/game'
import { currentGoal, goalFocus, goalMet, type GoalFocus } from '#shared/gridworks/goals'
import GridworksBuildIcon from './GridworksBuildIcon.vue'
import GridworksGuide from './GridworksGuide.vue'
import GridworksResearch from './GridworksResearch.vue'
import { GridEngine, fmt, type HoverInfo, type Selected, type Tool } from '~/utils/gridworks/engine'

const host = ref<HTMLElement | null>(null)
const game = useGridworks()
const { view, stock, cap, sol, progress, loading } = game
const colorMode = useColorMode()
const isDark = computed(() => colorMode.value !== 'light')

let engine: GridEngine | null = null
const eng = shallowRef<GridEngine | null>(null)
const tool = ref<Tool>({ mode: 'select' })
const rotation = ref(0)
const layer = ref(0)
const hover = ref<HoverInfo | null>(null)
const selected = ref<Selected | null>(null)
const muted = ref(false)
const researchOpen = ref(false)
const storageCollapsed = ref(false)
const banner = ref<{ id: string, key: number } | null>(null)
const showHelp = ref(false)

watch([isDark, eng], ([dark]) => eng.value?.setTheme(dark ? 'dark' : 'light'))

function toggleTheme() {
    colorMode.preference = isDark.value ? 'light' : 'dark'
    engine?.sfx.select()
}

// Cog's goals: the next one to claim, what it points at, and which button glows.
const goal = computed(() => view.value ? currentGoal(view.value) : null)
const goalDone = computed(() => !!goal.value && !!view.value && goalMet(goal.value, view.value, sol.value))
const focus = computed<GoalFocus>(() => !goal.value || !view.value || goalDone.value ? null : goalFocus(goal.value, view.value))
const focusKind = computed(() => focus.value?.startsWith('build:') ? focus.value.slice(6) as Kind : null)
let markerMemo: { key: string, marker: { x: number, y: number, w: number, h: number } | null } = { key: '', marker: null }
const guideMarker = computed(() => {
    const g = goal.value
    const v = view.value
    if (!g || !v || goalDone.value) return null
    const key = `${g.id}|${v.seed}|${v.layout}|${v.entities.length}|${v.chunks.length}`
    if (key !== markerMemo.key) markerMemo = { key, marker: g.marker?.(v) ?? null }
    return markerMemo.marker
})
watch([guideMarker, eng], ([m]) => eng.value?.setGuide(m))
watch([researchOpen, eng], ([open]) => eng.value?.setInputLocked(open))

function claimGoal(id: string) {
    engine?.sfx.unlock()
    const [err] = game.commit([{ op: 'goal', id }])
    if (err) engine?.sfx.invalid()
    else {
        engine?.sfx.goal()
        engine?.celebrateGoal()
    }
}

const CATEGORIES = [
    { id: 'logistics' as Category, label: 'Logistics', icon: Route },
    { id: 'production' as Category, label: 'Production', icon: Factory },
    { id: 'storage' as Category, label: 'Storage', icon: Package },
    { id: 'power' as Category, label: 'Boost', icon: Zap }
]
const done = computed(() => view.value?.done ?? [])
const hasUpgrades = computed(() => done.value.some(id => id.startsWith('belt-mk') || id.startsWith('machine-mk')))
const kindsIn = (c: Category) => (Object.keys(BUILDINGS) as Kind[]).filter(k => BUILDINGS[k].category === c && isUnlocked(k, done.value))
const categories = computed(() => CATEGORIES.filter(c => kindsIn(c.id).length))
const unlocked = computed(() => (Object.keys(BUILDINGS) as Kind[]).filter(k => isUnlocked(k, done.value)))

const SLOTS = 9
const HOTBAR_KEY = 'gridworks:hotbar'
const SEEN_KEY = 'gridworks:hotbar-seen'
const isKind = (k: unknown): k is Kind => typeof k === 'string' && Object.hasOwn(BUILDINGS, k)
const hotbar = ref<(Kind | null)[]>(Array.from({ length: SLOTS }, () => null))
let seen = new Set<Kind>()
try {
    const raw: unknown = JSON.parse(localStorage.getItem(HOTBAR_KEY) ?? 'null')
    if (Array.isArray(raw)) hotbar.value = Array.from({ length: SLOTS }, (_, i) => isKind(raw[i]) ? raw[i] : null)
    const old: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]')
    if (Array.isArray(old)) seen = new Set(old.filter(isKind))
} catch {
    // storage blocked or corrupt: start empty
}

function saveHotbar() {
    try {
        localStorage.setItem(HOTBAR_KEY, JSON.stringify(hotbar.value))
        localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]))
    } catch {
        // storage blocked
    }
}

watch([unlocked, view], ([list, v]) => {
    if (!v) return
    const bar = [...hotbar.value]
    let changed = false
    for (const k of list) {
        if (seen.has(k)) continue
        seen.add(k)
        changed = true
        const free = bar.indexOf(null)
        if (!bar.includes(k) && free >= 0) bar[free] = k
    }
    if (changed) {
        hotbar.value = bar
        saveHotbar()
    }
}, { immediate: true })

const slotKind = (i: number) => {
    const k = hotbar.value[i]
    return k && isUnlocked(k, done.value) ? k : null
}

const menu = ref<Category | null>(null)
const menuKinds = computed(() => menu.value ? kindsIn(menu.value) : [])
function toggleMenu(c: Category) {
    menu.value = menu.value === c ? null : c
    engine?.sfx.tool()
}

const drag = ref<{ kind: Kind, from: number | null } | null>(null)
const dropOver = ref<number | null>(null)
let dropped = false

function onDragStart(ev: DragEvent, kind: Kind, from: number | null) {
    drag.value = { kind, from }
    dropped = false
    ev.dataTransfer?.setData('text/plain', kind)
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move'
}

function onDrop(i: number) {
    const d = drag.value
    dropOver.value = null
    if (!d) return
    dropped = true
    const bar = [...hotbar.value]
    const src = d.from ?? bar.indexOf(d.kind)
    if (src === i) return
    if (src >= 0) bar[src] = bar[i] ?? null
    bar[i] = d.kind
    hotbar.value = bar
    saveHotbar()
    engine?.sfx.select()
}

function onDragEnd() {
    const d = drag.value
    if (d && d.from !== null && !dropped) {
        const bar = [...hotbar.value]
        bar[d.from] = null
        hotbar.value = bar
        saveHotbar()
        engine?.sfx.tool()
    }
    drag.value = null
    dropOver.value = null
}

const slotOf = (k: Kind) => hotbar.value.findIndex((x, i) => x === k && slotKind(i))

const items = computed(() => {
    const rates = sol.value?.store ?? {}
    return ITEM_IDS
        .filter(id => (stock.value[id] ?? 0) >= 1 || (rates[id] ?? 0) > 0)
        .map(id => ({ id, amount: stock.value[id] ?? 0, rate: (rates[id] ?? 0) * 60, full: (stock.value[id] ?? 0) >= cap.value - 0.5 }))
})

function fmtEta(sec: number): string {
    if (!Number.isFinite(sec) || sec <= 0) return ''
    if (sec < 60) return `${Math.ceil(sec)}s`
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`
    const h = sec / 3600
    if (h < 24) return `${h.toFixed(1)}h`
    return `${(h / 24).toFixed(1)}d`
}

const active = computed(() => {
    const id = view.value?.queue[0]
    const node = id ? RESEARCH_BY_ID[id] : null
    if (!node) return null
    const lab = sol.value?.lab ?? {}
    const parts = (Object.entries(node.cost) as [ItemId, number][]).map(([k, total]) => ({
        id: k, total, got: Math.min(total, progress.value[k] ?? 0), rate: (lab[k] ?? 0) * 60, rateSec: lab[k] ?? 0
    }))
    let eta = 0
    let feeding = true
    for (const p of parts) {
        const left = Math.max(0, p.total - p.got)
        if (left <= 0.01) continue
        if (p.rateSec <= 1e-6) {
            feeding = false
            break
        }
        eta = Math.max(eta, left / p.rateSec)
    }
    return {
        node,
        parts,
        eta: feeding && eta > 0 ? fmtEta(eta) : null,
        stalled: parts.every(p => p.rate <= 0)
    }
})

const researchFrac = computed(() => {
    const a = active.value
    if (!a) return null
    const total = a.parts.reduce((n, p) => n + p.total, 0)
    return total ? a.parts.reduce((n, p) => n + p.got, 0) / total : 0
})
watch([researchFrac, eng], ([f]) => eng.value?.setResearch(f))

function spriteUrl(k: Kind) {
    const s = BUILDINGS[k].sprite
    return s ? `/assets/gridworks/sprites/${s}` : ''
}
const itemUrl = (id: ItemId) => `/assets/gridworks/sprites/items/${id}.svg`
const researchIconUrl = (id: string) => `/assets/gridworks/sprites/research/${id}.svg`

function affordable(cost: Stock) {
    return canAfford(stock.value, cost)
}

function pick(k: Kind) {
    if (!engine) return
    if (tool.value.mode === 'build' && tool.value.kind === k) engine.setTool({ mode: 'select' })
    else engine.setTool({ mode: 'build', kind: k })
}

function setMode(mode: 'select' | 'remove' | 'upgrade') {
    engine?.setTool({ mode })
}

function onKey(ev: KeyboardEvent) {
    const t = ev.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return
    if (researchOpen.value && ev.key.toLowerCase() !== 't') return
    if (/^[1-9]$/.test(ev.key)) {
        const k = slotKind(Number(ev.key) - 1)
        if (k) pick(k)
        return
    }
    if (ev.key === 'Escape') menu.value = null
    if (ev.key === 'Tab') {
        ev.preventDefault()
        const list = categories.value
        if (!list.length) return
        const i = menu.value ? list.findIndex(c => c.id === menu.value) : (ev.shiftKey ? 0 : -1)
        menu.value = list[(i + (ev.shiftKey ? list.length - 1 : 1)) % list.length]!.id
        engine?.sfx.tool()
        return
    }
    if (ev.key.toLowerCase() === 't') researchOpen.value = !researchOpen.value
}

function toggleMute() {
    muted.value = !muted.value
    engine?.sfx.setMuted(muted.value)
}

function research(id: string) {
    engine?.sfx.unlock()
    const [err] = game.commit([{ op: 'research', id }])
    if (err) engine?.sfx.invalid()
    else engine?.sfx.select()
}

function unqueueResearch(id: string) {
    engine?.sfx.unlock()
    const [err] = game.commit([{ op: 'unqueue', id }])
    if (err) engine?.sfx.invalid()
    else engine?.sfx.tool()
}

const selDef = computed(() => selected.value ? BUILDINGS[selected.value.e.k] : null)
const selRecipe = computed(() => {
    const s = selected.value
    if (!s || !selDef.value?.recipes) return null
    return s.e.recipe ?? selDef.value.recipes[0]!
})
const selUpgrade = computed(() => {
    const s = selected.value
    if (!s) return null
    const mk = s.e.mk ?? 1
    const max = maxMk(s.e.k, done.value)
    if (BUILDINGS[s.e.k].role !== 'belt' && BUILDINGS[s.e.k].role !== 'machine' && BUILDINGS[s.e.k].role !== 'source') return null
    return { mk, max, cost: mk < max ? upgradeCost(s.e.k, mk + 1) : null }
})
const recipeLocked = (r: string) => RECIPES[r]?.out === 'chip' && !done.value.includes('electronics')

function costEntries(c: Stock) {
    return Object.entries(c) as [ItemId, number][]
}

let unmounted = false
let bannerTimer: ReturnType<typeof setTimeout> | null = null

onMounted(async () => {
    if (!host.value) return
    const created = new GridEngine(host.value, {
        commit: ops => game.commit(ops),
        stock: () => game.currentStock(),
        onSelect: s => { selected.value = s },
        onHover: h => { hover.value = h },
        onTool: (t, r) => {
            tool.value = t
            rotation.value = r
        },
        onLayer: l => { layer.value = l }
    })
    engine = created
    muted.value = engine.sfx.muted
    game.onView((v, animate) => engine?.setState(v, { animate }))
    game.onSolution((s, ents) => engine?.setSolution(s, ents))
    game.onWorld(plots => engine?.setWorld(plots, game.me.value))
    game.onResearch((id) => {
        engine?.sfx.research()
        engine?.celebrateResearch()
        banner.value = { id, key: Date.now() }
        if (bannerTimer) clearTimeout(bannerTimer)
        bannerTimer = setTimeout(() => { banner.value = null }, 3200)
    })
    await created.init(isDark.value ? 'dark' : 'light')
    if (unmounted) return
    eng.value = created
    await game.start()
    if (unmounted) return
    if (game.world.value.length) created.setWorld(game.world.value, game.me.value)
    if (view.value) created.setState(view.value, { animate: false })
    if (sol.value) created.setSolution(sol.value, game.solEntities())
    window.addEventListener('keydown', onKey)
    showHelp.value = localStorage.getItem('gridworks:help') === '1'
})

onBeforeUnmount(() => {
    unmounted = true
    if (bannerTimer) clearTimeout(bannerTimer)
    window.removeEventListener('keydown', onKey)
    game.stop()
    engine?.destroy()
    engine = null
    eng.value = null
})

function toggleHelp() {
    showHelp.value = !showHelp.value
    localStorage.setItem('gridworks:help', showHelp.value ? '1' : '0')
}
</script>

<template>
  <div
    class="gw-root relative h-full w-full select-none overflow-hidden text-sm"
    :class="isDark ? 'gw-dark' : 'gw-light'"
  >
    <div ref="host" class="absolute inset-0" />

    <div v-if="loading" class="gw-loading absolute inset-0 grid place-items-center">
      <div class="gw-ink-soft flex items-center gap-3">
        <LoaderCircle class="size-5 animate-spin" />
        Loading factory…
      </div>
    </div>

    <!-- Research: top left -->
    <div class="pointer-events-none absolute left-2.5 top-2.5 flex w-56 flex-col gap-1.5 sm:left-3 sm:top-3 sm:w-68">
      <div class="gw-panel pointer-events-auto rounded-xl border p-2.5 shadow-xl backdrop-blur sm:p-3">
        <div class="flex items-center justify-between gap-2">
          <div class="gw-ink-muted flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider">
            <FlaskConical class="size-3.5 text-violet-500 dark:text-violet-300" /> Research
          </div>
          <div class="flex items-center gap-1.5">
            <span v-if="active?.eta" class="font-mono text-[11px] font-semibold tabular-nums text-violet-600 dark:text-violet-300">
              {{ active.eta }}
            </span>
            <Tooltip v-else-if="active?.stalled">
              <TooltipTrigger as-child>
                <span class="size-2 rounded-full bg-amber-400" />
              </TooltipTrigger>
              <TooltipContent>Belt required items into a Lab</TooltipContent>
            </Tooltip>
            <button
              class="gw-btn-subtle flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium transition active:scale-95"
              :class="{ 'gw-guide': focus === 'research' }"
              @click="researchOpen = true"
            >
              Tree <kbd class="gw-kbd">T</kbd>
            </button>
          </div>
        </div>
        <template v-if="active">
          <div class="mt-2 flex items-center gap-2">
            <img :src="researchIconUrl(active.node.id)" class="size-6 shrink-0" alt="">
            <div class="truncate text-[13px] font-semibold">
              {{ active.node.name }}
            </div>
          </div>
          <div class="mt-1.5 flex flex-col gap-1">
            <div v-for="p in active.parts" :key="p.id" class="flex items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger as-child>
                  <img :src="itemUrl(p.id)" class="size-4 shrink-0" :alt="ITEMS[p.id].name">
                </TooltipTrigger>
                <TooltipContent>{{ ITEMS[p.id].name }}<template v-if="p.rate > 0"> (+{{ fmt(p.rate) }}/m)</template></TooltipContent>
              </Tooltip>
              <div class="gw-track relative h-1.5 flex-1 overflow-hidden rounded-full">
                <div class="absolute inset-y-0 left-0 rounded-full bg-violet-500 transition-[width] duration-300 dark:bg-violet-400" :style="{ width: `${(p.got / p.total) * 100}%` }" />
              </div>
              <span class="gw-ink-soft w-16 text-right font-mono text-[11px] tabular-nums">{{ fmt(p.got) }}/{{ fmt(p.total) }}</span>
            </div>
          </div>
        </template>
        <button
          v-else
          class="gw-btn-subtle mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium transition active:scale-[0.98]"
          :class="{ 'gw-guide': focus === 'research' }"
          @click="researchOpen = true"
        >
          Pick next tech <kbd class="gw-kbd">T</kbd>
        </button>
      </div>
    </div>

    <!-- Storage & utility buttons: top right -->
    <div class="pointer-events-none absolute right-2.5 top-2.5 flex flex-col items-end gap-1.5 sm:right-3 sm:top-3">
      <div class="gw-panel pointer-events-auto w-44 rounded-xl border p-2.5 shadow-xl backdrop-blur sm:w-56 sm:p-3">
        <button
          class="flex w-full items-center justify-between text-[11px] font-bold uppercase tracking-wider"
          @click="storageCollapsed = !storageCollapsed"
        >
          <span class="gw-ink-muted flex items-center gap-1.5"><Package class="size-3.5" /> Storage</span>
          <span class="gw-ink-muted flex items-center gap-1 font-mono text-[11px] font-medium normal-case tracking-normal">
            {{ fmt(cap) }}
            <ChevronDown v-if="storageCollapsed" class="size-3.5" />
            <ChevronUp v-else class="size-3.5" />
          </span>
        </button>
        <template v-if="!storageCollapsed">
          <TransitionGroup name="gw-row" tag="div" class="gw-storage mt-2 flex flex-col gap-1 overflow-y-auto overflow-x-hidden" :class="{ 'gw-storage-short': selected }">
            <Tooltip v-for="it in items" :key="it.id">
              <TooltipTrigger as-child>
                <div class="flex items-center gap-2">
                  <img :src="itemUrl(it.id)" class="size-4 shrink-0 sm:size-5" alt="">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-baseline justify-between gap-1">
                      <span class="font-mono text-xs font-semibold tabular-nums sm:text-[13px]" :class="it.full ? 'text-amber-500 dark:text-amber-300' : ''">{{ fmt(it.amount) }}</span>
                      <span v-if="it.rate > 0" class="font-mono text-[11px] font-medium tabular-nums text-emerald-600 dark:text-emerald-400">+{{ fmt(it.rate) }}/m</span>
                    </div>
                    <div class="gw-track h-0.5 overflow-hidden rounded-full">
                      <div class="h-full rounded-full transition-[width] duration-300" :class="it.full ? 'bg-amber-400' : 'gw-bar-fill'" :style="{ width: `${Math.min(100, (it.amount / Math.max(1, cap)) * 100)}%` }" />
                    </div>
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent side="left">{{ ITEMS[it.id].name }} · {{ Math.floor(it.amount) }} / {{ fmt(cap) }}</TooltipContent>
            </Tooltip>
          </TransitionGroup>
          <div v-if="!items.length" class="gw-ink-muted mt-1.5 text-xs">
            Empty
          </div>
        </template>
      </div>
      <div class="pointer-events-auto flex gap-1">
        <Tooltip>
          <TooltipTrigger as-child>
            <button class="gw-panel gw-icon-btn grid size-9 place-items-center rounded-lg border shadow-md backdrop-blur transition active:scale-90 sm:size-8" title="Center plot (H)" @click="eng?.focusPlot()">
              <Home class="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Center plot (H)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <button class="gw-panel gw-icon-btn grid size-9 place-items-center rounded-lg border shadow-md backdrop-blur transition active:scale-90 sm:size-8" :title="isDark ? 'Switch to light mode' : 'Switch to dark mode'" @click="toggleTheme">
              <Sun v-if="isDark" class="size-4" />
              <Moon v-else class="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{{ isDark ? 'Light mode' : 'Dark mode' }}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <button class="gw-panel gw-icon-btn grid size-9 place-items-center rounded-lg border shadow-md backdrop-blur transition active:scale-90 sm:size-8" :title="muted ? 'Sound off' : 'Sound on'" @click="toggleMute">
              <VolumeX v-if="muted" class="size-4" />
              <Volume2 v-else class="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{{ muted ? 'Unmute' : 'Mute' }}</TooltipContent>
        </Tooltip>
      </div>
    </div>

    <!-- Selected building -->
    <Transition name="gw-pop">
      <div v-if="selected && selDef" class="gw-panel absolute bottom-32 right-2.5 w-60 rounded-xl border p-3 shadow-2xl backdrop-blur sm:right-3 sm:w-64">
        <div class="mb-2 flex items-center gap-2">
          <img v-if="spriteUrl(selected.e.k)" :src="spriteUrl(selected.e.k)" class="size-9 object-contain" alt="">
          <div class="min-w-0 flex-1">
            <div class="truncate font-semibold">
              {{ selDef.name }} <span v-if="(selected.e.mk ?? 1) > 1" class="text-amber-500 dark:text-amber-300">Mk{{ selected.e.mk }}</span>
            </div>
            <div class="gw-ink-muted flex items-center gap-1.5 text-xs">
              <span
                class="size-1.5 rounded-full"
                :class="(selected.busy > 0.05 || selected.flow > 0) ? 'bg-emerald-400' : 'bg-amber-400'"
              />
              <template v-if="selDef.role === 'machine' || selDef.role === 'source'">
                {{ Math.round(selected.busy * 100) }}% active
              </template>
              <template v-else-if="selected.flow > 0">
                {{ fmt(selected.flow * 60) }}/m
              </template>
              <template v-else>
                Idle
              </template>
            </div>
          </div>
          <button class="gw-icon-btn grid size-6 place-items-center rounded-md" title="Close" @click="eng?.select(null)">
            <X class="size-3.5" />
          </button>
        </div>
        <div v-if="selDef.recipes && selDef.recipes.length > 1" class="mb-2">
          <div class="flex flex-wrap gap-1">
            <button
              v-for="r in selDef.recipes"
              :key="r"
              :disabled="recipeLocked(r)"
              class="flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition active:scale-95 disabled:opacity-40"
              :class="selRecipe === r ? 'border-sky-400 bg-sky-500/20 text-sky-700 dark:text-sky-200' : 'gw-chip-btn'"
              @click="eng?.act('recipe', r)"
            >
              <img :src="itemUrl(RECIPES[r]!.out)" class="size-4" alt=""> {{ ITEMS[RECIPES[r]!.out].name }}
            </button>
          </div>
        </div>
        <div v-if="selRecipe" class="gw-ink-soft mb-2 flex items-center gap-1 text-xs">
          <template v-for="([k, v], i) in costEntries(RECIPES[selRecipe]!.inputs)" :key="k">
            <span v-if="i" class="gw-ink-muted">+</span>
            <Tooltip>
              <TooltipTrigger as-child>
                <span class="flex items-center gap-0.5 tabular-nums"><img :src="itemUrl(k)" class="size-4" :alt="ITEMS[k].name">{{ v }}</span>
              </TooltipTrigger>
              <TooltipContent>{{ ITEMS[k].name }}</TooltipContent>
            </Tooltip>
          </template>
          <ArrowRight class="gw-ink-muted mx-0.5 size-3.5" />
          <Tooltip>
            <TooltipTrigger as-child>
              <span class="flex items-center gap-0.5 font-semibold tabular-nums"><img :src="itemUrl(RECIPES[selRecipe]!.out)" class="size-4" :alt="ITEMS[RECIPES[selRecipe]!.out].name">{{ RECIPES[selRecipe]!.outQty }}</span>
            </TooltipTrigger>
            <TooltipContent>{{ ITEMS[RECIPES[selRecipe]!.out].name }}</TooltipContent>
          </Tooltip>
          <span class="gw-ink-muted ml-auto font-mono text-[11px]">{{ RECIPES[selRecipe]!.time }}s</span>
        </div>
        <div v-if="selected.e.k === 'smart-splitter'" class="mb-2">
          <div class="gw-ink-muted mb-1 text-[11px] font-medium">
            Filter sideways
          </div>
          <div class="flex flex-wrap gap-1">
            <Tooltip v-for="id in ITEM_IDS" :key="id">
              <TooltipTrigger as-child>
                <button
                  class="grid size-7 place-items-center rounded-md border transition active:scale-90"
                  :class="selected.e.filter === id ? 'border-amber-400 bg-amber-400/20' : 'gw-chip-btn'"
                  @click="eng?.act('filter', selected.e.filter === id ? null : id)"
                >
                  <img :src="itemUrl(id)" class="size-5" :alt="ITEMS[id].name">
                </button>
              </TooltipTrigger>
              <TooltipContent>{{ ITEMS[id].name }}</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <div v-if="selUpgrade && selUpgrade.max > 1" class="mb-2">
          <button
            v-if="selUpgrade.cost"
            class="flex w-full items-center justify-between rounded-lg border border-amber-400/50 bg-amber-400/15 px-2 py-1.5 text-xs transition hover:bg-amber-400/25 active:scale-[0.98] disabled:opacity-40"
            :disabled="!affordable(selUpgrade.cost)"
            @click="eng?.act('upgrade')"
          >
            <span class="font-semibold text-amber-700 dark:text-amber-200">Mk{{ selUpgrade.mk + 1 }}</span>
            <span class="flex items-center gap-1.5">
              <Tooltip v-for="[k, v] in costEntries(selUpgrade.cost)" :key="k">
                <TooltipTrigger as-child>
                  <span class="flex items-center gap-0.5 tabular-nums"><img :src="itemUrl(k)" class="size-4" :alt="ITEMS[k].name">{{ fmt(v) }}</span>
                </TooltipTrigger>
                <TooltipContent>{{ ITEMS[k].name }}</TooltipContent>
              </Tooltip>
            </span>
          </button>
          <div v-else class="gw-ink-muted text-[11px]">
            Max Mk
          </div>
        </div>
        <div class="flex gap-1.5">
          <button class="gw-btn-subtle flex flex-1 items-center justify-center gap-1 rounded-lg py-1.5 text-xs font-medium transition active:scale-95" @click="eng?.act('rotate')">
            <RotateCw class="size-3.5" /> <kbd class="gw-kbd">R</kbd>
          </button>
          <button class="flex flex-1 items-center justify-center gap-1 rounded-lg bg-red-500/15 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-500/25 active:scale-95 dark:text-red-300" @click="eng?.act('remove')">
            <Trash2 class="size-3.5" /> <kbd class="gw-kbd">X</kbd>
          </button>
        </div>
      </div>
    </Transition>

    <!-- Build bar: bottom -->
    <div class="pointer-events-none absolute inset-x-0 bottom-2.5 flex flex-col items-center gap-1.5 px-2 sm:bottom-3">
      <!-- Category drawer -->
      <div v-if="menu && menuKinds.length" class="gw-panel pointer-events-auto flex max-w-full flex-col items-center gap-1 rounded-2xl border p-2 shadow-2xl backdrop-blur">
        <div class="flex flex-wrap justify-center gap-1.5">
          <Tooltip v-for="k in menuKinds" :key="k">
            <TooltipTrigger as-child>
              <button
                class="gw-slot"
                :class="[tool.mode === 'build' && tool.kind === k ? 'gw-slot-on' : '', affordable(BUILDINGS[k].cost) ? '' : 'gw-slot-poor', focusKind === k && slotOf(k) < 0 ? 'gw-guide' : '']"
                draggable="true"
                @click="pick(k); menu = null"
                @dragstart="onDragStart($event, k, null)"
                @dragend="onDragEnd"
              >
                <GridworksBuildIcon :kind="k" />
                <span v-if="slotOf(k) >= 0" class="gw-key">{{ slotOf(k) + 1 }}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" :side-offset="10">
              <div class="text-xs leading-snug">
                <div class="font-semibold">{{ BUILDINGS[k].name }}</div>
                <div class="mt-1 flex items-center gap-2">
                  <span v-for="[c, v] in costEntries(BUILDINGS[k].cost)" :key="c" class="flex items-center gap-1 tabular-nums" :class="(stock[c] ?? 0) >= v ? '' : 'text-red-400'">
                    <img :src="itemUrl(c)" class="size-4" alt="">{{ fmt(v) }}
                  </span>
                </div>
              </div>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <!-- Category pills -->
      <div class="gw-panel pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1 rounded-xl border p-1 shadow-xl backdrop-blur">
        <button
          v-for="c in categories"
          :key="c.id"
          class="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition active:scale-95 sm:gap-1.5 sm:px-2.5"
          :class="[menu === c.id ? 'gw-cat-on' : 'gw-cat-off', focusKind && menu !== c.id && slotOf(focusKind) < 0 && BUILDINGS[focusKind].category === c.id && isUnlocked(focusKind, done) ? 'gw-guide' : '']"
          @click="toggleMenu(c.id)"
        >
          <component :is="c.icon" class="size-3.5" />
          <span class="hidden sm:inline">{{ c.label }}</span>
        </button>
        <kbd class="gw-kbd ml-0.5 hidden sm:inline-flex">Tab</kbd>
      </div>

      <!-- Hotbar -->
      <div class="gw-panel pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1 rounded-2xl border p-1.5 shadow-2xl backdrop-blur sm:gap-1.5 sm:p-2">
        <Tooltip>
          <TooltipTrigger as-child>
            <button
              class="gw-slot"
              :class="tool.mode === 'select' ? 'gw-slot-on' : ''"
              @click="setMode('select')"
            >
              <MousePointer2 class="size-5 sm:size-6" />
              <span class="gw-key">Esc</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Select &amp; move (Esc)</TooltipContent>
        </Tooltip>

        <Tooltip v-if="hasUpgrades">
          <TooltipTrigger as-child>
            <button
              class="gw-slot"
              :class="tool.mode === 'upgrade' ? 'gw-slot-on gw-slot-gold' : ''"
              @click="setMode(tool.mode === 'upgrade' ? 'select' : 'upgrade')"
            >
              <ArrowUpCircle class="size-5 sm:size-6" />
              <span class="gw-key">U</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Drag-upgrade Mk (U)</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <button
              class="gw-slot"
              :class="tool.mode === 'remove' ? 'gw-slot-on gw-slot-red' : ''"
              @click="setMode(tool.mode === 'remove' ? 'select' : 'remove')"
            >
              <Trash2 class="size-5 sm:size-6" />
              <span class="gw-key">X</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Remove (X or right-drag)</TooltipContent>
        </Tooltip>

        <div class="gw-sep mx-0.5 hidden h-10 w-px self-center sm:block" />

        <div class="flex flex-wrap items-center justify-center gap-1 sm:gap-1.5">
          <div
            v-for="i in SLOTS"
            :key="i"
            :class="i > 5 && !slotKind(i - 1) ? 'hidden sm:block' : ''"
            @dragover.prevent="dropOver = i - 1"
            @dragleave="dropOver === i - 1 && (dropOver = null)"
            @drop.prevent="onDrop(i - 1)"
          >
            <Tooltip v-if="slotKind(i - 1)">
              <TooltipTrigger as-child>
                <button
                  class="gw-slot"
                  :class="[tool.mode === 'build' && tool.kind === slotKind(i - 1) ? 'gw-slot-on' : '', affordable(BUILDINGS[slotKind(i - 1)!].cost) ? '' : 'gw-slot-poor', focusKind === slotKind(i - 1) && !(tool.mode === 'build' && tool.kind === focusKind) ? 'gw-guide' : '', dropOver === i - 1 ? 'gw-slot-drop' : '', drag?.from === i - 1 ? 'opacity-40' : '']"
                  draggable="true"
                  @click="pick(slotKind(i - 1)!)"
                  @dragstart="onDragStart($event, slotKind(i - 1)!, i - 1)"
                  @dragend="onDragEnd"
                >
                  <GridworksBuildIcon :kind="slotKind(i - 1)!" :turn="tool.mode === 'build' && tool.kind === slotKind(i - 1) ? rotation : 0" />
                  <span class="gw-key">{{ i }}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" :side-offset="10">
                <div class="text-xs leading-snug">
                  <div class="font-semibold">{{ BUILDINGS[slotKind(i - 1)!].name }}</div>
                  <div class="mt-1 flex items-center gap-2">
                    <span v-for="[c, v] in costEntries(BUILDINGS[slotKind(i - 1)!].cost)" :key="c" class="flex items-center gap-1 tabular-nums" :class="(stock[c] ?? 0) >= v ? '' : 'text-red-400'">
                      <img :src="itemUrl(c)" class="size-4" alt="">{{ fmt(v) }}
                    </span>
                  </div>
                </div>
              </TooltipContent>
            </Tooltip>
            <div v-else class="gw-slot gw-slot-empty" :class="dropOver === i - 1 ? 'gw-slot-drop' : ''">
              <span class="gw-key">{{ i }}</span>
            </div>
          </div>
        </div>

        <template v-if="done.includes('bridges')">
          <div class="gw-sep mx-0.5 hidden h-10 w-px self-center sm:block" />
          <Tooltip>
            <TooltipTrigger as-child>
              <button class="gw-slot" @click="eng?.setLayer(layer >= (done.includes('skyway') ? 2 : 1) ? 0 : layer + 1)">
                <div class="flex flex-col-reverse gap-0.5">
                  <div v-for="l in (done.includes('skyway') ? 3 : 2)" :key="l" class="h-1.5 w-6 rounded-sm transition sm:w-7" :class="l - 1 === layer ? 'bg-sky-400' : 'gw-track'" />
                </div>
                <span class="gw-key">L</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Belt layer {{ layer + 1 }} (L)</TooltipContent>
          </Tooltip>
        </template>
      </div>
    </div>

    <!-- Cog and controls: bottom left -->
    <div class="gw-corner pointer-events-none absolute left-2.5 flex flex-col items-start gap-2 sm:left-3">
      <Transition name="gw-pop">
        <div v-if="showHelp" class="gw-panel pointer-events-auto w-56 rounded-xl border p-3 text-xs shadow-xl backdrop-blur">
          <div class="mb-1.5 flex items-center justify-between font-semibold">
            Shortcuts
            <button class="gw-icon-btn grid size-5 place-items-center rounded" @click="toggleHelp">
              <X class="size-3.5" />
            </button>
          </div>
          <div class="grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-0.5">
            <span class="gw-ink-muted">Hold ore</span><span>Mine</span>
            <span class="gw-ink-muted">Drag</span><span>Belts / move</span>
            <span class="gw-ink-muted">R</span><span>Rotate</span>
            <span class="gw-ink-muted">U</span><span>Drag-upgrade</span>
            <span class="gw-ink-muted">Right-drag</span><span>Remove</span>
            <span class="gw-ink-muted">Q</span><span>Copy / miner</span>
            <span class="gw-ink-muted">Ctrl+Z</span><span>Undo</span>
            <span class="gw-ink-muted">WASD</span><span>Pan · wheel zoom</span>
          </div>
        </div>
      </Transition>
      <GridworksGuide v-if="view && goal" :goal="goal" :state="view" :sol="sol" :sfx="eng?.sfx" @claim="claimGoal" @help="toggleHelp" />
      <button v-else-if="view" class="gw-panel gw-icon-btn pointer-events-auto grid size-9 place-items-center rounded-xl border shadow-xl backdrop-blur transition" title="Controls" @click="toggleHelp">
        <Keyboard class="size-4" />
      </button>
    </div>

    <!-- Cursor tooltip -->
    <div
      v-if="hover && !researchOpen"
      class="gw-tooltip pointer-events-none fixed z-50 max-w-60 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl backdrop-blur"
      :style="{ left: `${hover.x + 18}px`, top: `${hover.y + 18}px` }"
    >
      <div class="font-semibold">
        {{ hover.title }}
      </div>
      <div v-for="l in hover.lines" :key="l" class="gw-ink-soft">
        {{ l }}
      </div>
      <div v-if="hover.error" class="font-medium text-red-500 dark:text-red-400">
        {{ hover.error }}
      </div>
    </div>

    <!-- Research done banner -->
    <Transition name="gw-banner">
      <div v-if="banner" :key="banner.key" class="pointer-events-none absolute left-1/2 top-5 -translate-x-1/2 rounded-2xl border border-violet-400/50 bg-violet-600/90 px-6 py-2.5 text-center text-white shadow-2xl backdrop-blur dark:bg-violet-500/25">
        <div class="text-[11px] font-bold uppercase tracking-widest text-violet-100 dark:text-violet-200">
          Unlocked
        </div>
        <div class="text-base font-bold sm:text-lg">
          {{ RESEARCH_BY_ID[banner.id]?.name }}
        </div>
      </div>
    </Transition>

    <GridworksResearch
      v-model:open="researchOpen"
      :state="view"
      :stock="stock"
      :dark="isDark"
      @research="research"
      @unqueue="unqueueResearch"
    />
  </div>
</template>

<style scoped>
.gw-root {
  container-type: size;
  color: var(--gw-ink);
  background: var(--gw-bg);
}
.gw-dark {
  --gw-bg: #11151c;
  --gw-panel: rgb(15 18 25 / 0.86);
  --gw-panel-solid: #11151e;
  --gw-border: rgb(255 255 255 / 0.11);
  --gw-ink: #f8fafc;
  --gw-ink-soft: rgb(255 255 255 / 0.72);
  --gw-ink-muted: rgb(255 255 255 / 0.48);
  --gw-track: rgb(255 255 255 / 0.1);
  --gw-bar: rgb(255 255 255 / 0.3);
  --gw-chip: rgb(255 255 255 / 0.08);
  --gw-hover: rgb(255 255 255 / 0.12);
  --gw-slot-bg: rgb(255 255 255 / 0.05);
  --gw-slot-border: rgb(255 255 255 / 0.09);
  --gw-slot-empty: rgb(255 255 255 / 0.14);
  --gw-kbd-bg: rgb(255 255 255 / 0.09);
  --gw-kbd-border: rgb(255 255 255 / 0.18);
  --gw-guide-border: rgb(94 234 212 / 0.3);
  --gw-guide-pill-bg: rgb(45 212 191 / 0.16);
  --gw-guide-pill-fg: rgb(153 246 228);
}
.gw-light {
  --gw-bg: #dce4ef;
  --gw-panel: rgb(255 255 255 / 0.88);
  --gw-panel-solid: #ffffff;
  --gw-border: rgb(15 23 42 / 0.12);
  --gw-ink: #0f172a;
  --gw-ink-soft: #334155;
  --gw-ink-muted: #64748b;
  --gw-track: rgb(15 23 42 / 0.09);
  --gw-bar: #64748b;
  --gw-chip: rgb(15 23 42 / 0.06);
  --gw-hover: rgb(15 23 42 / 0.09);
  --gw-slot-bg: rgb(15 23 42 / 0.04);
  --gw-slot-border: rgb(15 23 42 / 0.11);
  --gw-slot-empty: rgb(15 23 42 / 0.16);
  --gw-kbd-bg: rgb(15 23 42 / 0.07);
  --gw-kbd-border: rgb(15 23 42 / 0.15);
  --gw-guide-border: rgb(13 148 136 / 0.35);
  --gw-guide-pill-bg: rgb(13 148 136 / 0.12);
  --gw-guide-pill-fg: #0f766e;
}
.gw-loading { background: var(--gw-bg); }
.gw-panel { background: var(--gw-panel); border-color: var(--gw-border); color: var(--gw-ink); }
.gw-tooltip { background: var(--gw-panel-solid); border-color: var(--gw-border); color: var(--gw-ink); }
.gw-ink-soft { color: var(--gw-ink-soft); }
.gw-ink-muted { color: var(--gw-ink-muted); }
.gw-track { background: var(--gw-track); }
.gw-bar-fill { background: var(--gw-bar); }
.gw-sep { background: var(--gw-border); }
.gw-btn-subtle { background: var(--gw-chip); color: var(--gw-ink); }
.gw-btn-subtle:hover { background: var(--gw-hover); }
.gw-chip-btn { border-color: var(--gw-border); color: var(--gw-ink); }
.gw-chip-btn:hover { background: var(--gw-hover); }
.gw-icon-btn { color: var(--gw-ink-soft); }
.gw-icon-btn:hover { background: var(--gw-hover); color: var(--gw-ink); }
.gw-cat-on { background: var(--gw-hover); color: var(--gw-ink); }
.gw-cat-off { color: var(--gw-ink-muted); }
.gw-cat-off:hover { color: var(--gw-ink); }

.gw-corner { bottom: 8.5rem; }
@container (min-width: 1580px) {
  .gw-corner { bottom: 0.75rem; }
}
.gw-storage { max-height: max(6.5rem, calc(100cqh - 17rem)); scrollbar-width: thin; }
.gw-storage-short { max-height: max(6.5rem, calc(100cqh - 36rem)); }
.gw-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 1.05rem;
  min-width: 1.05rem;
  padding: 0 0.25rem;
  border-radius: 0.25rem;
  border: 1px solid var(--gw-kbd-border);
  background: var(--gw-kbd-bg);
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1;
  color: var(--gw-ink-soft);
}
.gw-slot {
  position: relative;
  display: grid;
  place-items: center;
  width: 2.85rem;
  height: 2.85rem;
  border-radius: 0.7rem;
  border: 1px solid var(--gw-slot-border);
  background: var(--gw-slot-bg);
  color: var(--gw-ink);
  transition: transform 140ms cubic-bezier(.3, 1.6, .5, 1), background 120ms, border-color 120ms, box-shadow 120ms;
}
@media (min-width: 640px) {
  .gw-slot {
    width: 3.35rem;
    height: 3.35rem;
    border-radius: 0.75rem;
  }
}
.gw-slot:hover { background: var(--gw-hover); }
.gw-slot:active { transform: scale(0.92); }
.gw-slot-on {
  background: rgb(56 189 248 / 0.2);
  border-color: rgb(56 189 248 / 0.85);
  box-shadow: 0 0 0 3px rgb(56 189 248 / 0.2), 0 0 14px -4px rgb(56 189 248 / 0.55);
}
.gw-slot-red {
  background: rgb(248 113 113 / 0.18);
  border-color: rgb(248 113 113 / 0.85);
  box-shadow: 0 0 0 3px rgb(248 113 113 / 0.2);
}
.gw-slot-gold {
  background: rgb(251 191 36 / 0.22);
  border-color: rgb(251 191 36 / 0.9);
  box-shadow: 0 0 0 3px rgb(251 191 36 / 0.2);
}
.gw-slot-poor img, .gw-slot-poor svg { opacity: 0.42; filter: grayscale(0.6); }
.gw-slot-empty { border: 1px dashed var(--gw-slot-empty); background: transparent; }
.gw-slot-empty:hover { transform: none; background: transparent; }
.gw-slot-drop { outline: 2px solid rgb(56 189 248 / 0.8); outline-offset: 1px; background: rgb(56 189 248 / 0.14); }
.gw-guide { animation: gw-guide 1.3s ease-in-out infinite; }
@keyframes gw-guide {
  0%, 100% { box-shadow: 0 0 0 2px rgb(45 212 191 / 0.9), 0 0 0 4px rgb(45 212 191 / 0.16); }
  50% { box-shadow: 0 0 0 2px rgb(45 212 191 / 0.9), 0 0 14px 6px rgb(45 212 191 / 0.45); }
}
.gw-key {
  position: absolute;
  right: 3px;
  top: 2px;
  font-size: 9px;
  font-family: var(--font-mono);
  color: var(--gw-ink-muted);
}
.gw-pop-enter-active, .gw-pop-leave-active { transition: opacity 160ms, transform 200ms cubic-bezier(.3, 1.4, .5, 1); }
.gw-pop-enter-from, .gw-pop-leave-to { opacity: 0; transform: translateY(8px) scale(0.97); }
.gw-banner-enter-active { transition: opacity 250ms, transform 450ms cubic-bezier(.3, 1.6, .5, 1); }
.gw-banner-leave-active { transition: opacity 400ms, transform 400ms; }
.gw-banner-enter-from { opacity: 0; transform: translate(-50%, -16px) scale(0.85); }
.gw-banner-leave-to { opacity: 0; transform: translate(-50%, -8px); }
.gw-row-enter-active { transition: opacity 250ms, transform 300ms cubic-bezier(.3, 1.4, .5, 1); }
.gw-row-enter-from { opacity: 0; transform: translateX(12px); }
</style>
