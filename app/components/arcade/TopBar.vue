<script setup lang="ts">
import { LogOut } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'

/**
 * The lobby's bar. Slim when embedded in the hub (the hub's own bar shows the player), with
 * the name and sign-out when the arcade runs on its own domain.
 */
const { player, signOut } = useArcadeSession()
const { embedded } = useHubBridge()
</script>

<template>
  <header class="sticky top-0 z-40 shrink-0 border-b bg-background/85 backdrop-blur">
    <div class="mx-auto flex h-11 max-w-7xl items-center gap-3 px-4">
      <NuxtLink to="/" class="font-display text-lg font-extrabold tracking-tight whitespace-nowrap">
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
