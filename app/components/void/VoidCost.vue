<template>
    <div class="vc">
        <span v-for="item in items" :key="item.id" class="vc-item" :class="{ 'vc-short': item.short }" :title="item.name">
            <i class="vr-gem" :style="{ '--c': item.hex }" />{{ formatNumber(item.amount, false) }}
        </span>
        <span v-if="!items.length" class="vc-free">Free</span>
    </div>
</template>

<script setup lang="ts">
import { VOID_RESOURCE_IDS, voidHex, voidResource, type VoidResourceBundle } from '#shared/void-runner/void'

const props = defineProps<{
    cost: VoidResourceBundle
    held: VoidResourceBundle
}>()

const items = computed(() => VOID_RESOURCE_IDS
    .filter(id => (props.cost[id] ?? 0) > 0)
    .map(id => ({
        id,
        name: voidResource(id).name,
        hex: voidHex(voidResource(id).color),
        amount: props.cost[id]!,
        short: (props.held[id] ?? 0) < props.cost[id]!
    })))
</script>

<style>
.vc { display: flex; flex-wrap: wrap; gap: 4px 10px; }
.vc-item { display: inline-flex; align-items: center; gap: 5px; font: 600 12px 'JetBrains Mono', monospace; }
.vc-short { color: #ff8095; }
.vc-free { font-size: 12px; color: var(--vr-muted); }
</style>
