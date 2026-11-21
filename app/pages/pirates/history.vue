<script setup lang="ts">
import type { PirateLogEntry } from '#shared/pirate-raid/api'

const { data: voyages, pending, error, refresh } = await useAsyncData('pirate-log', () => apiFetch<PirateLogEntry[]>('/api/pirates/history'))

const totalLoot = computed(() => voyages.value?.reduce((sum, voyage) => sum + voyage.loot, 0) ?? 0)
const totalKills = computed(() => voyages.value?.reduce((sum, voyage) => sum + voyage.kills, 0) ?? 0)
const bestSurvivalMs = computed(() => voyages.value?.reduce((best, voyage) => Math.max(best, voyage.durationMs), 0) ?? 0)

function durationLabel(ms: number) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000))
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function dateLabel(value: number) {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function outcome(voyage: PirateLogEntry) {
    if (voyage.completed) {
        return { label: 'Made it home', icon: 'i-lucide-crown', color: '#3ddc97' }
    }
    if (voyage.reason === 'cancelled') {
        return { label: 'Turned for port', icon: 'i-lucide-flag', color: '#93a8b6' }
    }
    return { label: 'Sunk', icon: 'i-lucide-skull', color: '#f0524f' }
}
</script>

<template>
  <div class="mx-auto w-full max-w-6xl space-y-6 px-3 sm:px-6">
    <header class="flex flex-wrap items-end justify-between gap-3">
      <h1 class="pr-display text-5xl leading-none sm:text-6xl">
        Log
      </h1>
      <PiratesButton variant="wood" icon="i-lucide-refresh-cw" aria-label="Refresh" :loading="pending" @click="refresh()" />
    </header>

    <div v-if="pending" class="space-y-3">
      <div class="grid gap-3 sm:grid-cols-3">
        <div v-for="i in 3" :key="i" class="pr-skeleton h-24" />
      </div>
      <div v-for="i in 6" :key="i" class="pr-skeleton h-28" />
    </div>

    <template v-else-if="voyages?.length">
      <div class="grid gap-3 sm:grid-cols-3">
        <div class="pr-panel flex items-center gap-3 p-4">
          <div class="grid size-11 place-items-center rounded-full pr-glow text-[var(--pr-teal)]" style="--glow: #2dd4bf">
            <PiratesIcon name="i-lucide-map" class="size-5" />
          </div>
          <div>
            <p class="pr-dim text-[10px] font-bold uppercase tracking-wider">Voyages</p>
            <p class="text-2xl font-black">{{ voyages.length }}</p>
          </div>
        </div>
        <div class="pr-panel flex items-center gap-3 p-4">
          <div class="grid size-11 place-items-center rounded-full pr-glow text-[var(--pr-gold)]" style="--glow: #f3c35a">
            <PiratesDoubloonIcon class="size-5" />
          </div>
          <div>
            <p class="pr-dim text-[10px] font-bold uppercase tracking-wider">Doubloons</p>
            <PiratesDoubloons :value="totalLoot" class="text-2xl font-black" />
          </div>
        </div>
        <div class="pr-panel flex items-center gap-3 p-4">
          <div class="grid size-11 place-items-center rounded-full pr-glow text-[var(--pr-blood)]" style="--glow: #f0524f">
            <PiratesIcon name="i-lucide-skull" class="size-5" />
          </div>
          <div>
            <p class="pr-dim text-[10px] font-bold uppercase tracking-wider">Ships sunk · best time</p>
            <p class="text-2xl font-black">{{ totalKills }} · {{ durationLabel(bestSurvivalMs) }}</p>
          </div>
        </div>
      </div>

      <div class="space-y-2">
        <div
          v-for="voyage in voyages"
          :key="voyage.id"
          class="pr-panel log-row"
          :style="{ '--tone': outcome(voyage).color }"
        >
          <div class="flex min-w-0 items-center gap-3 lg:w-2/5">
            <div class="log-ship">
              <PiratesShipPreview :skin-id="voyage.skin.id" class="h-full w-full" />
            </div>
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="pr-tag" :style="{ '--tag': outcome(voyage).color }"><PiratesIcon :name="outcome(voyage).icon" class="size-3" />{{ outcome(voyage).label }}</span>
                <span class="pr-tag">Difficulty {{ voyage.difficulty }}</span>
              </div>
              <p class="mt-1.5 truncate font-bold">{{ voyage.skin.name }}</p>
              <p class="pr-dim truncate text-xs">{{ dateLabel(voyage.createdAt) }} · {{ voyage.shotsFired }} shots</p>
            </div>
          </div>

          <div class="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-4">
            <div class="pr-inset px-3 py-2">
              <p class="pr-dim text-[10px] font-bold uppercase tracking-wider">Afloat</p>
              <p class="text-xl font-black">{{ durationLabel(voyage.durationMs) }}</p>
            </div>
            <div class="pr-inset px-3 py-2">
              <p class="pr-dim text-[10px] font-bold uppercase tracking-wider">Power</p>
              <p class="text-xl font-black text-[var(--pr-teal)]">{{ voyage.power }}</p>
            </div>
            <div class="pr-inset px-3 py-2">
              <p class="pr-dim text-[10px] font-bold uppercase tracking-wider">Sunk</p>
              <p class="text-xl font-black">{{ voyage.kills }}</p>
            </div>
            <div class="pr-inset px-3 py-2">
              <p class="pr-dim text-[10px] font-bold uppercase tracking-wider">Doubloons</p>
              <PiratesDoubloons :value="voyage.loot" class="text-xl font-black" />
            </div>
          </div>
        </div>
      </div>
    </template>

    <div v-else-if="error" class="pr-panel flex items-center gap-3 p-4 text-sm text-[var(--pr-blood)]">
      <PiratesIcon name="i-lucide-circle-alert" class="size-5" />
      Could not load the log
    </div>

    <div v-else class="pr-parchment py-12 text-center">
      <PiratesIcon name="i-lucide-scroll-text" class="mx-auto size-10 opacity-60" />
      <p class="mt-3 text-xl font-bold" style="font-family: Cinzel, serif">
        No voyages yet
      </p>
      <PiratesButton class="mt-4" variant="gold" to="/pirates" icon="i-lucide-sailboat" label="Set sail" />
    </div>
  </div>
</template>

<style scoped>
.log-row {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 0.85rem 1rem 0.85rem 1.1rem;
  border-left: 3px solid var(--tone);
}
@media (min-width: 1024px) {
  .log-row { flex-direction: row; align-items: center; }
}
.log-ship {
  width: 8.5rem;
  height: 5.5rem;
  flex-shrink: 0;
  border-radius: 0.7rem;
  background: radial-gradient(ellipse at 50% 60%, rgba(45, 212, 191, 0.15), transparent 70%), linear-gradient(180deg, #0f2b3d, #081723);
  box-shadow: inset 0 0 0 1px rgba(201, 151, 60, 0.3);
}
</style>
