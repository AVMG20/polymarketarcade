<script setup lang="ts">
import { ChevronLeft, LogOut } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { gameForPath } from '#shared/games'

/**
 * Slim when embedded in the hub (the hub's own bar shows the player), with
 * the name and sign-out when the arcade runs on its own domain.
 */
const { player, signOut } = useArcadeSession()
const { embedded } = useHubBridge()
const route = useRoute()
const game = computed(() => gameForPath(route.path))
/** Sub-pages of a game go back to the game, the game itself to the lobby. */
const back = computed(() => {
    if (!game.value) return null
    return route.path === game.value.path ? { to: '/', label: 'Arcade' } : { to: game.value.path, label: game.value.name }
})
</script>

<template>
  <header class="sticky top-0 z-40 shrink-0 border-b bg-background/85 backdrop-blur">
    <div class="mx-auto flex h-11 max-w-7xl items-center gap-3 px-4">
      <NuxtLink v-if="back" :to="back.to" class="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ChevronLeft class="size-4" />
        {{ back.label }}
      </NuxtLink>
      <NuxtLink v-else to="/" class="font-display text-lg font-extrabold tracking-tight whitespace-nowrap">
        Polynux <span class="text-primary">Arcade</span>
      </NuxtLink>

      <div v-if="!embedded && player" class="ml-auto flex items-center gap-2">
        <img v-if="player.image" :src="player.image" alt="" class="size-7 rounded-full object-cover">
        <span class="hidden text-sm font-medium sm:inline">{{ player.name }}</span>
        <Button size="icon-sm" variant="ghost" title="Sign out" @click="signOut">
          <LogOut class="size-4" />
        </Button>
      </div>
    </div>
  </header>
</template>
