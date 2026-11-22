<script setup lang="ts">
import TownBoostIcon from '~/components/polytown/TownBoostIcon.vue'
import { TOWN_BOOSTER_KINDS, townBoosterLabel, type TownBoosters } from '#shared/polytown/town-boosts'

// A bag of boosters as reward tags: one per kind, its badge and how many.
// What the old site's gem tags were.
const props = withDefaults(defineProps<{ boosters?: TownBoosters | null, size?: number }>(), { boosters: null, size: 14 })
const kinds = computed(() => TOWN_BOOSTER_KINDS.filter(k => (props.boosters?.[k] ?? 0) > 0))
</script>

<template>
  <span v-for="k in kinds" :key="k" class="g-tag g-tag-gem town-booster-tag" :data-tip="k === 'builder' ? 'Free builder' : townBoosterLabel(k)">
    <TownBoostIcon :kind="k" :size="size" />{{ (boosters?.[k] ?? 0) > 1 ? `×${boosters?.[k]}` : '' }}
  </span>
</template>

<style>
.town-booster-tag { gap: 3px; }
</style>
