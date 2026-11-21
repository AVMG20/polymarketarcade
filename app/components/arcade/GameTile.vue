<script setup lang="ts">
import { Users } from 'lucide-vue-next'
import type { ArcadeGame } from '#shared/games'

defineProps<{ game: ArcadeGame }>()
</script>

<template>
  <NuxtLink
    :to="game.path"
    class="group block overflow-hidden rounded-2xl border bg-card transition-transform duration-200 ease-[cubic-bezier(.34,1.56,.64,1)] hover:scale-[1.03] motion-reduce:hover:scale-100"
  >
    <div class="relative aspect-[16/10] overflow-hidden bg-muted">
      <img :src="game.cover" :alt="game.name" loading="lazy" class="size-full object-cover">
      <span v-if="game.multiplayer" class="absolute top-2 right-2 inline-flex items-center gap-1 rounded-full bg-background/85 px-2 py-0.5 text-xs font-semibold backdrop-blur" title="Multiplayer">
        <Users class="size-3.5" /> Co-op
      </span>
    </div>
    <div class="space-y-1 p-3">
      <h3 class="font-display leading-tight font-bold">{{ game.name }}</h3>
      <p class="line-clamp-2 text-xs text-muted-foreground">{{ game.tagline }}</p>
    </div>
  </NuxtLink>
</template>
