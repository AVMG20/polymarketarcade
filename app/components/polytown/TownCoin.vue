<script setup lang="ts">
import TownIcon from '~/components/polytown/TownIcon.vue'
// The site's coin glyph (same as CoinBalance) so Polytown prices read like the rest of Polynux.
</script>

<template>
    <TownIcon name="i-lucide-coins" class="town-coin" />
</template>

<style scoped>
.town-coin { display: inline-block; width: 1em; height: 1em; color: var(--g-gold); vertical-align: -0.12em; flex-shrink: 0; }
</style>
