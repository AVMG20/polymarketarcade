<script setup lang="ts">
// A mayor's face: their hub avatar, or the first letter of their name. Stands
// in for the old site's drawn emblem.
const props = defineProps<{ image?: string | null, name: string }>()
const failed = ref(false)
const initial = computed(() => (props.name.trim()[0] ?? '?').toUpperCase())
</script>

<template>
  <span class="town-face">
    <img v-if="image && !failed" :src="image" :alt="name" referrerpolicy="no-referrer" @error="failed = true">
    <span v-else>{{ initial }}</span>
  </span>
</template>

<style>
.town-face {
    display: inline-flex; align-items: center; justify-content: center;
    width: 100%; height: 100%; overflow: hidden; border-radius: 9999px;
    background: var(--g-accent, #2a9d8f); color: #fff; font-weight: 700; font-size: 0.7em; line-height: 1;
}
.town-face img { width: 100%; height: 100%; object-fit: cover; }
</style>
