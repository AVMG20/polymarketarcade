<script setup lang="ts">
import { Crosshair, Wrench } from 'lucide-vue-next'

definePageMeta({ layout: 'game' })

const route = useRoute()
const tabs = [
    { label: 'Arena', to: '/shapezz', icon: Crosshair },
    { label: 'Workshop', to: '/shapezz/workshop', icon: Wrench }
]
</script>

<template>
  <div class="flex h-full flex-col bg-[#04020f] text-white">
    <nav class="flex shrink-0 items-center gap-1 border-b border-white/10 px-2">
      <NuxtLink
        v-for="tab in tabs"
        :key="tab.to"
        :to="tab.to"
        class="flex min-h-11 items-center gap-2 border-b-2 px-3 text-sm font-bold tracking-wide uppercase transition-colors"
        :class="route.path === tab.to ? 'border-cyan-300 text-white' : 'border-transparent text-white/50 hover:text-white'"
      >
        <component :is="tab.icon" class="size-4" />
        {{ tab.label }}
      </NuxtLink>
    </nav>
    <div class="relative min-h-0 flex-1">
      <NuxtPage />
    </div>
  </div>
</template>
