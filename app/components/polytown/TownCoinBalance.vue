<script setup lang="ts">
import TownIcon from '~/components/polytown/TownIcon.vue'

// A coin amount with the coin icon: the old site's <CoinBalance>, with the
// exact amount on hover through the town's own tooltip.
const props = withDefaults(defineProps<{
    value: string | number | null | undefined
    compact?: boolean
    showIcon?: boolean
}>(), { compact: true, showIcon: true })

const parsed = computed(() => parseFloat(String(props.value ?? '0')))
</script>

<template>
  <div class="town-coin-balance" :data-tip="formatNumber(parsed, false)">
    <TownIcon v-if="showIcon" name="i-lucide-coins" class="town-coin-balance-ico" />
    <span>{{ formatNumber(parsed, compact) }}</span>
  </div>
</template>

<style>
.town-coin-balance { display: flex; align-items: center; gap: 0.375rem; cursor: default; }
.town-coin-balance-ico { width: 1rem !important; height: 1rem !important; flex-shrink: 0; color: #facc15; }
</style>
