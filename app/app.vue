<script setup lang="ts">
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { gameForPath } from '#shared/games'

const { status } = useArcadeSession()
const { postTitle } = useHubBridge()
const route = useRoute()
const game = computed(() => gameForPath(route.path))

useHead({ titleTemplate: title => (title ? `${title} · Polynux Arcade` : 'Polynux Arcade') })
useHead(() => ({ title: game.value?.name }))
watch(() => game.value?.name ?? 'Arcade', title => postTitle(title), { immediate: true })
</script>

<template>
  <TooltipProvider :delay-duration="150">
    <div v-if="status === 'loading'" class="grid min-h-dvh place-items-center">
      <div class="size-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
    </div>
    <ArcadeSignIn v-else-if="status === 'signed-out'" />
    <NuxtLayout v-else>
      <NuxtPage />
    </NuxtLayout>
  </TooltipProvider>
  <Toaster rich-colors position="top-center" />
</template>
