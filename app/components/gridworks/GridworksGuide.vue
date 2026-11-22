<script setup lang="ts">
import { Keyboard, LoaderCircle, Minus, Star } from 'lucide-vue-next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GOALS, goalMet, type Goal } from '#shared/gridworks/goals'
import { ITEMS, type ItemId } from '#shared/gridworks/defs'
import type { Solution } from '#shared/gridworks/flow'
import type { GridState } from '#shared/gridworks/game'
import { GRIDWORKS_STAR_GOAL } from '#shared/stars'
import { fmt } from '~/utils/gridworks/engine'
import type { GridSfx } from '~/utils/gridworks/sfx'

const props = defineProps<{ goal: Goal | null, state: GridState | null, sol: Solution | null, sfx?: GridSfx }>()
const emit = defineEmits<{ claim: [id: string], help: [] }>()

const minimized = ref(false)
const cheering = ref(false)
const typed = ref(0)
let typer: ReturnType<typeof setInterval> | null = null
let cheerTimer: ReturnType<typeof setTimeout> | null = null

const progress = computed<[number, number]>(() => props.goal && props.state ? props.goal.progress(props.state, props.sol) : [0, 1])
const met = computed(() => !!props.goal && !!props.state && goalMet(props.goal, props.state, props.sol))
const index = computed(() => props.goal ? GOALS.indexOf(props.goal) + 1 : GOALS.length)
const rewards = computed(() => Object.entries(props.goal?.reward ?? {}) as [ItemId, number][])
const isStarGoal = computed(() => props.goal?.id === GRIDWORKS_STAR_GOAL)
const text = computed(() => props.goal?.say ?? '')
const shown = computed(() => text.value.slice(0, typed.value))
const typing = computed(() => typed.value < text.value.length)

const pose = computed(() => {
    if (cheering.value) return 'cheer'
    if (met.value && rewards.value.length) return 'cheer'
    return props.goal?.pose ?? 'idle'
})
const avatar = computed(() => `/assets/gridworks/sprites/mascot/cog${pose.value === 'idle' ? '' : `-${pose.value}`}.svg`)

function stopTyping() {
    if (typer) clearInterval(typer)
    typer = null
}

function startTyping() {
    stopTyping()
    typed.value = 0
    if (minimized.value || !text.value) {
        typed.value = text.value.length
        return
    }
    typer = setInterval(() => {
        typed.value = Math.min(text.value.length, typed.value + 1)
        const ch = text.value[typed.value - 1] ?? ''
        // Cosmetic pitch jitter for the talk blips.
        if (/[aeiouy]/i.test(ch)) props.sfx?.talk(Math.random())
        if (!typing.value) stopTyping()
    }, 18)
}

function skip() {
    if (!typing.value) return
    stopTyping()
    typed.value = text.value.length
}

function claim() {
    if (!props.goal || !met.value) return
    emit('claim', props.goal.id)
    cheering.value = true
    if (cheerTimer) clearTimeout(cheerTimer)
    cheerTimer = setTimeout(() => { cheering.value = false }, 1400)
}

function toggle() {
    minimized.value = !minimized.value
    localStorage.setItem('gridworks:guide', minimized.value ? 'min' : 'open')
    props.sfx?.select()
    if (!minimized.value) startTyping()
    else skip()
}

watch(() => props.goal?.id, startTyping)

onMounted(() => {
    minimized.value = localStorage.getItem('gridworks:guide') === 'min'
    startTyping()
})

onBeforeUnmount(() => {
    stopTyping()
    if (cheerTimer) clearTimeout(cheerTimer)
})

const itemUrl = (id: string) => `/assets/gridworks/sprites/items/${id}.svg`
</script>

<template>
  <div class="pointer-events-none flex items-end gap-2">
    <button
      class="gw-cog pointer-events-auto relative shrink-0 transition active:scale-90"
      :class="{ 'gw-cog-cheer': cheering }"
      :title="minimized ? 'Show Cog' : 'Hide Cog'"
      @click="toggle"
    >
      <img :src="avatar" class="size-14 drop-shadow-[0_6px_10px_rgba(0,0,0,0.4)] sm:size-16" alt="Cog">
      <span
        v-if="minimized && met"
        class="absolute -right-0.5 top-0.5 grid size-5 place-items-center rounded-full bg-teal-400 text-xs font-bold text-teal-950 shadow-lg"
      >!</span>
    </button>

    <Transition name="gw-bubble">
      <div
        v-if="!minimized && goal"
        class="gw-guide-card pointer-events-auto relative mb-1.5 w-64 rounded-2xl border p-2.5 shadow-2xl backdrop-blur sm:w-72 sm:p-3"
      >
        <div class="gw-guide-tail absolute -left-[7px] bottom-5 size-3 rotate-45 border-b border-l" />

        <div class="mb-1 flex items-center gap-1.5">
          <span class="gw-goal-pill rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider">
            {{ index }}/{{ GOALS.length }}
          </span>
          <span class="truncate text-[13px] font-semibold">{{ goal.title }}</span>
          <Tooltip v-if="isStarGoal">
            <TooltipTrigger as-child>
              <span class="inline-flex items-center gap-0.5 rounded-md bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-500 dark:text-amber-300">
                <Star class="size-3 fill-current" /> Star
              </span>
            </TooltipTrigger>
            <TooltipContent>Earns your Arcade Star for Gridworks</TooltipContent>
          </Tooltip>
          <div class="ml-auto flex items-center gap-0.5">
            <button class="gw-icon-btn grid size-6 place-items-center rounded-md transition" title="Controls" @click="emit('help')">
              <Keyboard class="size-3.5" />
            </button>
            <button class="gw-icon-btn grid size-6 place-items-center rounded-md transition" title="Hide" @click="toggle">
              <Minus class="size-3.5" />
            </button>
          </div>
        </div>

        <p class="gw-ink-soft min-h-[2.4rem] cursor-default text-xs leading-snug" @click="skip">
          {{ shown }}<span v-if="typing" class="gw-caret">▍</span>
        </p>

        <div v-if="progress[1] > 1" class="mt-1.5">
          <div class="gw-ink-muted mb-0.5 flex justify-between text-[11px] tabular-nums">
            <span>{{ fmt(Math.min(progress[0], progress[1])) }} / {{ fmt(progress[1]) }}</span>
            <span>{{ Math.round(Math.min(1, progress[0] / progress[1]) * 100) }}%</span>
          </div>
          <div class="gw-bar-track h-1.5 overflow-hidden rounded-full">
            <div class="h-full rounded-full bg-teal-400 transition-[width] duration-300" :style="{ width: `${Math.min(1, progress[0] / progress[1]) * 100}%` }" />
          </div>
        </div>

        <div class="mt-2 flex items-center gap-1.5">
          <div v-if="rewards.length" class="flex flex-wrap items-center gap-1 text-xs">
            <Tooltip v-for="[k, v] in rewards" :key="k">
              <TooltipTrigger as-child>
                <span class="gw-chip flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums">
                  <img :src="itemUrl(k)" class="size-3.5" :alt="ITEMS[k as ItemId]?.name ?? k">+{{ fmt(v) }}
                </span>
              </TooltipTrigger>
              <TooltipContent>Reward: +{{ fmt(v) }} {{ ITEMS[k as ItemId]?.name ?? k }}</TooltipContent>
            </Tooltip>
          </div>
          <button
            v-if="met"
            class="gw-claim ml-auto rounded-lg bg-teal-500 px-3 py-1 text-xs font-semibold text-white transition hover:bg-teal-400 active:scale-95 dark:bg-teal-400 dark:text-teal-950 dark:hover:bg-teal-300"
            @click="claim"
          >
            {{ rewards.length ? 'Claim' : 'Done' }}
          </button>
          <span v-else class="gw-ink-muted ml-auto flex items-center gap-1 text-[11px]">
            <LoaderCircle class="size-3 animate-spin [animation-duration:2.5s]" /> Active
          </span>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.gw-guide-card {
  background: var(--gw-panel);
  border-color: var(--gw-guide-border);
  color: var(--gw-ink);
}
.gw-guide-tail {
  background: var(--gw-panel-solid);
  border-color: var(--gw-guide-border);
}
.gw-goal-pill {
  background: var(--gw-guide-pill-bg);
  color: var(--gw-guide-pill-fg);
}
.gw-ink-soft { color: var(--gw-ink-soft); }
.gw-ink-muted { color: var(--gw-ink-muted); }
.gw-bar-track { background: var(--gw-track); }
.gw-chip { background: var(--gw-chip); color: var(--gw-ink); }
.gw-icon-btn { color: var(--gw-ink-muted); }
.gw-icon-btn:hover { background: var(--gw-hover); color: var(--gw-ink); }
.gw-cog img { animation: gw-bob 2.6s ease-in-out infinite; }
.gw-cog:hover img { animation-duration: 1.2s; }
.gw-cog-cheer img { animation: gw-hop 0.5s cubic-bezier(.3, 1.6, .5, 1) 2; }
@keyframes gw-bob {
  0%, 100% { transform: translateY(0) rotate(-2deg); }
  50% { transform: translateY(-4px) rotate(2deg); }
}
@keyframes gw-hop {
  0%, 100% { transform: translateY(0) scale(1); }
  40% { transform: translateY(-14px) scale(1.06, 0.96); }
}
.gw-caret { animation: gw-blink 0.8s steps(2) infinite; color: var(--gw-guide-pill-fg); }
@keyframes gw-blink { 50% { opacity: 0; } }
.gw-claim { animation: gw-glow 1.4s ease-in-out infinite; }
@keyframes gw-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgb(45 212 191 / 0.5); }
  50% { box-shadow: 0 0 0 6px rgb(45 212 191 / 0); }
}
.gw-bubble-enter-active, .gw-bubble-leave-active { transition: opacity 180ms, transform 260ms cubic-bezier(.3, 1.5, .5, 1); transform-origin: bottom left; }
.gw-bubble-enter-from, .gw-bubble-leave-to { opacity: 0; transform: translateX(-10px) scale(0.9); }
</style>
