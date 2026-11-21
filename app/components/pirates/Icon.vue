<script setup lang="ts">
// Pirate Raid icons by their old Iconify names (`i-lucide-anchor`), so names
// can live in shared game data. Only the icons the game uses are bundled.
import {
    Anchor, ArrowBigUpDash, ArrowLeftRight, ArrowRight, Bomb, Check, ChevronLeft, ChevronRight, CircleAlert, CircleDot, Crosshair, Crown, Flag, Flame, Ghost, Hammer, Heart, HeartPulse, Hourglass, Link, LoaderCircle, Lock, Map as MapIcon, Maximize, Minimize, Package, Pause, Play, RefreshCw, Rocket, Sailboat, ScrollText, Shield, ShieldHalf, ShieldPlus, Ship, Skull, Swords, Telescope, Timer, TimerReset, Tornado, Trash2, TriangleAlert, Trophy, Volume2, VolumeX, Waves, Wind, Wrench, X, Zap
} from 'lucide-vue-next'
import type { Component } from 'vue'

const props = defineProps<{ name: string }>()

const ICONS: Record<string, Component> = {
    'anchor': Anchor,
    'arrow-big-up-dash': ArrowBigUpDash,
    'arrow-left-right': ArrowLeftRight,
    'arrow-right': ArrowRight,
    'bomb': Bomb,
    'check': Check,
    'chevron-left': ChevronLeft,
    'chevron-right': ChevronRight,
    'circle-alert': CircleAlert,
    'circle-dot': CircleDot,
    'crosshair': Crosshair,
    'crown': Crown,
    'flag': Flag,
    'flame': Flame,
    'ghost': Ghost,
    'hammer': Hammer,
    'heart': Heart,
    'heart-pulse': HeartPulse,
    'hourglass': Hourglass,
    'link': Link,
    'loader-circle': LoaderCircle,
    'lock': Lock,
    'map': MapIcon,
    'maximize': Maximize,
    'minimize': Minimize,
    'package': Package,
    'pause': Pause,
    'play': Play,
    'refresh-cw': RefreshCw,
    'rocket': Rocket,
    'sailboat': Sailboat,
    'scroll-text': ScrollText,
    'shield': Shield,
    'shield-half': ShieldHalf,
    'shield-plus': ShieldPlus,
    'ship': Ship,
    'skull': Skull,
    'swords': Swords,
    'telescope': Telescope,
    'timer': Timer,
    'timer-reset': TimerReset,
    'tornado': Tornado,
    'trash-2': Trash2,
    'triangle-alert': TriangleAlert,
    'trophy': Trophy,
    'volume-2': Volume2,
    'volume-x': VolumeX,
    'waves': Waves,
    'wind': Wind,
    'wrench': Wrench,
    'x': X,
    'zap': Zap
}

const icon = computed(() => ICONS[props.name.replace(/^i-lucide-/, '')] ?? Anchor)
</script>

<template>
  <component :is="icon" aria-hidden="true" />
</template>
