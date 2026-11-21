<template>
    <div class="vx-zc" :class="{ 'vx-zc-center': center, 'vx-zc-small': small }">
        <div v-if="depth" class="vx-zc-danger" :title="`Danger ${danger} of 5`">
            <VoidIcon v-for="n in 5" :key="n" name="i-lucide-skull" :class="{ 'vx-zc-on': n <= danger }" />
        </div>
        <div class="vx-zc-chips">
            <i v-for="t in def.boons" :key="t" class="vx-zc-up"><VoidIcon name="i-lucide-chevron-up" />{{ t }}</i>
            <i v-for="t in def.banes" :key="t" class="vx-zc-down"><VoidIcon name="i-lucide-chevron-down" />{{ t }}</i>
        </div>
    </div>
</template>

<script setup lang="ts">
import { voidJumpDanger, voidZone } from '#shared/void-runner/void-pilot'

// A zone's upsides and downsides as green and red chips, with the jump's danger in skulls.
const props = defineProps<{
    zone: string
    /** The jump this zone is (or would be); omit to leave the skulls out. */
    depth?: number
    center?: boolean
    small?: boolean
}>()

const def = computed(() => voidZone(props.zone))
const danger = computed(() => voidJumpDanger(props.depth ?? 1, props.zone))
</script>
