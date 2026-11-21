<script setup lang="ts">
// A doubloon amount: a plain integer with the coin mark.
withDefaults(defineProps<{ value: number, showIcon?: boolean }>(), { showIcon: true })
</script>

<template>
  <span class="inline-flex items-center gap-1 whitespace-nowrap tabular-nums">
    <PiratesDoubloonIcon v-if="showIcon" />
    {{ Math.floor(value) }}
  </span>
</template>
