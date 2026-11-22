<script setup lang="ts">
import { Check, Factory, FlaskConical, Lock, MoonStar, Route, X } from 'lucide-vue-next'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ITEMS, RESEARCH, TIER_GATE, researchAvailable, tierOpen, type Branch, type ItemId, type ResearchNode, type Stock } from '#shared/gridworks/defs'
import type { GridState } from '#shared/gridworks/game'
import { fmt } from '~/utils/gridworks/engine'

const props = defineProps<{ state: GridState | null, stock: Stock, dark?: boolean }>()
const emit = defineEmits<{ research: [id: string], unqueue: [id: string] }>()
const open = defineModel<boolean>('open', { default: false })

const BRANCHES = [
    { id: 'production' as Branch, label: 'Production', icon: Factory, text: 'text-sky-600 dark:text-sky-300', rgb: '56 189 248' },
    { id: 'logistics' as Branch, label: 'Logistics', icon: Route, text: 'text-amber-600 dark:text-amber-300', rgb: '245 158 11' },
    { id: 'idle' as Branch, label: 'Idle', icon: MoonStar, text: 'text-emerald-600 dark:text-emerald-300', rgb: '16 185 129' }
]
const tiers = [1, 2, 3, 4, 5]
const done = computed(() => props.state?.done ?? [])
const doneCount = computed(() => done.value.length)

type Status = 'done' | 'active' | 'open' | 'locked'
function status(n: ResearchNode): Status {
    if (done.value.includes(n.id)) return 'done'
    if (props.state?.queue.includes(n.id)) return 'active'
    return researchAvailable(n.id, done.value) ? 'open' : 'locked'
}

function queueIndex(n: ResearchNode): number {
    return props.state?.queue.indexOf(n.id) ?? -1
}

function clickNode(n: ResearchNode) {
    const st = status(n)
    if (st === 'open') emit('research', n.id)
    else if (st === 'active') emit('unqueue', n.id)
}

function pct(n: ResearchNode) {
    const got = props.state?.progress[n.id] ?? {}
    const parts = Object.entries(n.cost) as [ItemId, number][]
    if (!parts.length) return 0
    return parts.reduce((a, [k, v]) => a + Math.min(1, (got[k] ?? 0) / v), 0) / parts.length
}

function gate(tier: number) {
    const need = TIER_GATE[tier] ?? 0
    const have = RESEARCH.filter(n => n.tier === tier - 1 && done.value.includes(n.id)).length
    return { need, have: Math.min(have, need), open: tierOpen(tier, done.value) }
}

const nodes = (b: Branch, t: number) => RESEARCH.filter(r => r.branch === b && r.tier === t)
const iconUrl = (id: string) => `/assets/gridworks/sprites/research/${id}.svg`
const itemUrl = (id: string) => `/assets/gridworks/sprites/items/${id}.svg`
// Progress ring around the active badge (r = 30 in a 64 box).
const RING = 2 * Math.PI * 30
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      :show-close-button="false"
      class="gw-research flex max-h-[90dvh] max-w-[calc(100%-1.5rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl"
      :class="dark !== false ? 'gw-res-dark' : 'gw-res-light'"
    >
      <DialogHeader class="gw-res-head border-b px-5 py-3.5 text-left">
        <div class="flex w-full items-center gap-3">
          <div class="grid size-9 shrink-0 place-items-center rounded-xl bg-violet-500/20 ring-1 ring-violet-400/40">
            <FlaskConical class="size-5 text-violet-500 dark:text-violet-200" />
          </div>
          <div class="min-w-0">
            <DialogTitle class="text-base font-bold">
              Research Tree
            </DialogTitle>
            <DialogDescription class="gw-res-muted text-xs">
              Click to queue · click again to pause
            </DialogDescription>
          </div>
          <div class="ml-auto flex items-center gap-3">
            <div class="gw-res-muted text-right text-xs">
              <span class="gw-res-strong text-base font-bold tabular-nums">{{ doneCount }}</span>/{{ RESEARCH.length }}
            </div>
            <button class="gw-res-close grid size-8 place-items-center rounded-lg transition" aria-label="Close research" title="Close (T)" @click="open = false">
              <X class="size-4" />
            </button>
          </div>
        </div>
      </DialogHeader>

      <div class="gw-tree min-h-0 flex-1 overflow-auto p-4">
        <div class="grid min-w-[980px] grid-cols-[110px_repeat(5,1fr)] gap-x-3 gap-y-3">
          <!-- Tier headers with the gate to open each one -->
          <div />
          <div v-for="t in tiers" :key="t" class="flex flex-col items-center gap-1 pb-1">
            <div class="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.18em]" :class="gate(t).open ? 'gw-res-strong' : 'gw-res-dim'">
              <Lock v-if="!gate(t).open" class="size-3" />
              Tier {{ t }}
            </div>
            <div v-if="t > 1 && !gate(t).open" class="flex items-center gap-1" :title="`Finish ${gate(t).need} tier ${t - 1} researches`">
              <span
                v-for="i in gate(t).need"
                :key="i"
                class="size-1.5 rounded-full"
                :class="i <= gate(t).have ? 'bg-violet-400' : 'gw-res-dot'"
              />
              <span class="gw-res-muted ml-1 text-[10px] tabular-nums">{{ gate(t).have }}/{{ gate(t).need }}</span>
            </div>
            <div v-else class="h-1 w-10 rounded-full" :class="t === 1 || gate(t).open ? 'bg-violet-400/50' : ''" />
          </div>

          <template v-for="b in BRANCHES" :key="b.id">
            <div class="gw-lane-label flex flex-col justify-center gap-1 rounded-xl px-3" :style="{ '--c': b.rgb }">
              <component :is="b.icon" class="size-5" :class="b.text" />
              <div class="text-xs font-bold uppercase tracking-wider" :class="b.text">
                {{ b.label }}
              </div>
            </div>
            <div v-for="t in tiers" :key="t" class="gw-lane flex flex-col gap-2 rounded-xl p-1.5" :style="{ '--c': b.rgb }">
              <button
                v-for="n in nodes(b.id, t)"
                :key="n.id"
                class="gw-node group relative flex items-start gap-2.5 rounded-xl border p-2 text-left"
                :class="`gw-${status(n)}`"
                :style="{ '--c': b.rgb }"
                :disabled="status(n) === 'locked' || status(n) === 'done'"
                :title="status(n) === 'active' ? 'Click to unqueue (progress kept)' : undefined"
                @click="clickNode(n)"
              >
                <div class="relative size-12 shrink-0">
                  <div class="gw-badge absolute inset-0 grid place-items-center rounded-xl">
                    <img :src="iconUrl(n.id)" class="size-10 transition-transform duration-200 group-hover:scale-110" alt="">
                  </div>
                  <svg v-if="status(n) === 'active'" viewBox="0 0 64 64" class="pointer-events-none absolute -inset-1.5 size-[3.75rem] -rotate-90">
                    <circle cx="32" cy="32" r="30" fill="none" stroke="currentColor" stroke-opacity="0.14" stroke-width="3" />
                    <circle
                      cx="32" cy="32" r="30" fill="none" stroke="rgb(139 92 246)" stroke-width="3.2" stroke-linecap="round"
                      :stroke-dasharray="RING" :stroke-dashoffset="RING * (1 - pct(n))" class="transition-[stroke-dashoffset] duration-700"
                    />
                  </svg>
                  <div v-if="status(n) === 'done'" class="absolute -bottom-1 -right-1 grid size-5 place-items-center rounded-full bg-emerald-500 text-white shadow dark:bg-emerald-400 dark:text-emerald-950">
                    <Check class="size-3.5" />
                  </div>
                  <div v-else-if="status(n) === 'locked'" class="gw-res-lock-badge absolute -bottom-1 -right-1 grid size-5 place-items-center rounded-full shadow">
                    <Lock class="size-3" />
                  </div>
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1 text-[13px] font-semibold leading-tight">
                    <span class="truncate">{{ n.name }}</span>
                    <span v-if="status(n) === 'active'" class="ml-auto shrink-0 rounded bg-violet-500/20 px-1 text-[10px] font-bold uppercase tracking-wide text-violet-600 dark:text-violet-200">
                      {{ queueIndex(n) > 0 ? `#${queueIndex(n) + 1}` : `${Math.floor(pct(n) * 100)}%` }}
                    </span>
                  </div>
                  <div class="gw-res-muted mt-0.5 text-[11px] leading-tight">
                    {{ n.desc }}
                  </div>
                  <div v-if="status(n) !== 'done'" class="mt-1.5 flex flex-wrap gap-1">
                    <Tooltip v-for="[k, v] in Object.entries(n.cost)" :key="k">
                      <TooltipTrigger as-child>
                        <span class="gw-res-cost flex items-center gap-0.5 rounded-md px-1 py-px text-[11px] font-medium tabular-nums">
                          <img :src="itemUrl(k)" class="size-3.5" :alt="ITEMS[k as ItemId]?.name ?? k">{{ fmt(v) }}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{{ ITEMS[k as ItemId]?.name ?? k }}</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              </button>
            </div>
          </template>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.gw-res-dark {
  --r-bg: #0d1016;
  --r-dot: rgb(255 255 255 / 0.05);
  --r-border: rgb(255 255 255 / 0.1);
  --r-ink: #f8fafc;
  --r-muted: rgb(255 255 255 / 0.55);
  --r-dim: rgb(255 255 255 / 0.3);
  --r-node-bg: rgb(15 17 21 / 0.9);
  --r-cost-bg: rgb(0 0 0 / 0.35);
  --r-lock-bg: #272d38;
  --r-lock-fg: rgb(255 255 255 / 0.7);
  --r-locked-border: rgb(255 255 255 / 0.07);
  --r-locked-bg: rgb(255 255 255 / 0.02);
  --r-hover: rgb(255 255 255 / 0.1);
}
.gw-res-light {
  --r-bg: #f4f6fa;
  --r-dot: rgb(15 23 42 / 0.06);
  --r-border: rgb(15 23 42 / 0.1);
  --r-ink: #0f172a;
  --r-muted: #475569;
  --r-dim: #94a3b8;
  --r-node-bg: rgb(255 255 255 / 0.92);
  --r-cost-bg: rgb(15 23 42 / 0.07);
  --r-lock-bg: #e2e8f0;
  --r-lock-fg: #475569;
  --r-locked-border: rgb(15 23 42 / 0.08);
  --r-locked-bg: rgb(255 255 255 / 0.5);
  --r-hover: rgb(15 23 42 / 0.08);
}
.gw-research {
  background: var(--r-bg);
  border-color: var(--r-border);
  color: var(--r-ink);
}
.gw-res-head { border-color: var(--r-border); }
.gw-res-strong { color: var(--r-ink); }
.gw-res-muted { color: var(--r-muted); }
.gw-res-dim { color: var(--r-dim); }
.gw-res-dot { background: var(--r-border); }
.gw-res-cost { background: var(--r-cost-bg); color: var(--r-ink); }
.gw-res-lock-badge { background: var(--r-lock-bg); color: var(--r-lock-fg); border: 1px solid var(--r-border); }
.gw-res-close { color: var(--r-muted); }
.gw-res-close:hover { background: var(--r-hover); color: var(--r-ink); }
.gw-tree {
  background-color: var(--r-bg);
  background-image: radial-gradient(var(--r-dot) 1px, transparent 1px);
  background-size: 18px 18px;
}
.gw-lane-label {
  background: linear-gradient(90deg, rgb(var(--c) / 0.16), rgb(var(--c) / 0.03));
  border: 1px solid rgb(var(--c) / 0.22);
}
.gw-lane { background: rgb(var(--c) / 0.04); }
.gw-node {
  transition: transform 160ms cubic-bezier(.3, 1.5, .5, 1), border-color 140ms, background 140ms, box-shadow 160ms;
}
.gw-badge {
  background: radial-gradient(circle at 35% 30%, rgb(var(--c) / 0.32), rgb(var(--c) / 0.08) 70%);
  box-shadow: inset 0 0 0 1px rgb(var(--c) / 0.35);
}
.gw-open {
  cursor: pointer;
  border-color: rgb(var(--c) / 0.4);
  background: linear-gradient(160deg, rgb(var(--c) / 0.14), var(--r-node-bg) 60%);
}
.gw-open:hover {
  transform: translateY(-2px);
  border-color: rgb(var(--c) / 0.85);
  box-shadow: 0 10px 24px -10px rgb(var(--c) / 0.5);
}
.gw-open:active { transform: scale(0.97); }
.gw-active {
  cursor: pointer;
  border-color: rgb(139 92 246);
  background: linear-gradient(160deg, rgb(139 92 246 / 0.22), var(--r-node-bg) 70%);
  animation: gw-active 2.2s ease-in-out infinite;
}
@keyframes gw-active {
  0%, 100% { box-shadow: 0 0 0 1px rgb(139 92 246 / 0.4), 0 0 16px -4px rgb(139 92 246 / 0.45); }
  50% { box-shadow: 0 0 0 1px rgb(139 92 246 / 0.7), 0 0 24px -2px rgb(139 92 246 / 0.7); }
}
.gw-done {
  border-color: rgb(16 185 129 / 0.3);
  background: rgb(16 185 129 / 0.09);
}
.gw-done .gw-badge { filter: saturate(0.75); }
.gw-locked {
  cursor: not-allowed;
  border-color: var(--r-locked-border);
  background: var(--r-locked-bg);
  opacity: 0.72;
}
.gw-locked .gw-badge img { filter: grayscale(0.8) brightness(0.85); }
</style>
