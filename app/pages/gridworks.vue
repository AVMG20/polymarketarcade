<script setup lang="ts">
import GridworksGame from '~/components/gridworks/GridworksGame.client.vue'

definePageMeta({ layout: 'game' })
useHead({ title: 'Gridworks' })
</script>

<template>
  <div class="absolute inset-0">
    <GridworksGame />
  </div>
</template>
