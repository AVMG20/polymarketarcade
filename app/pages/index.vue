<script setup lang="ts">
import { ARCADE_GAMES } from '#shared/games'
</script>

<template>
  <div class="mx-auto w-full max-w-5xl px-4 py-6">
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <ArcadeGameTile v-for="game in ARCADE_GAMES" :key="game.slug" :game="game" />
    </div>
    <p v-if="!ARCADE_GAMES.length" class="py-16 text-center text-sm text-muted-foreground">No games yet.</p>
  </div>
</template>
