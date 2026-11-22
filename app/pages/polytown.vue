<script setup lang="ts">
import TownGame from '~/components/polytown/TownGame.client.vue'

definePageMeta({ layout: 'game' })
useHead({ title: 'Polytown' })
</script>

<template>
  <div class="absolute inset-0">
    <TownGame />
  </div>
</template>
