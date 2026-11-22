<script setup lang="ts">
import TownIcon from '~/components/polytown/TownIcon.vue'
import TownCoin from '~/components/polytown/TownCoin.vue'
import TownFace from '~/components/polytown/TownFace.vue'
interface Row {
    rank: number
    userId: string
    name: string
    /** Hub avatar. */
    image: string | null
    /** Hub title (the arcade has no prestige). */
    title: string | null
    incomePerDay: number
    buildings: number
    plots: number
    popCap: number
    happiness: number
    maxTier: number
    me: boolean
}

const emit = defineEmits<{ close: [] }>()

const { data, pending, refresh } = useAsyncData<{ rows: Row[], me: Row | null } | null>(
    'town-leaderboard',
    () => apiFetch<{ rows: Row[], me: Row | null }>('/api/polytown/leaderboard'),
    { server: false, default: () => null }
)

const rows = computed(() => data.value?.rows ?? [])
const me = computed(() => data.value?.me ?? null)
const meListed = computed(() => rows.value.some(r => r.me))
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <div class="g-window-head">
            <h2>Mayors</h2>
            <div class="flex gap-2">
                <button class="g-icon g-icon-sm" data-tip="Refresh" @click="refresh()">
                    <TownIcon name="i-lucide-refresh-cw" :class="pending ? 'animate-spin' : ''" />
                </button>
                <button class="g-icon g-icon-sm" @click="emit('close')"><TownIcon name="i-lucide-x" /></button>
            </div>
        </div>
        <div class="g-window-body">
            <div v-if="pending && !data" class="flex justify-center py-8"><span class="g-spinner" /></div>
            <div v-else-if="rows.length === 0" class="g-empty">No towns founded yet.</div>
            <div v-else class="space-y-1.5">
                <div v-for="r in rows" :key="r.userId" class="g-row mayor" :class="r.me ? 'is-me' : ''">
                    <span class="mayor-rank">
                        <TownIcon v-if="r.rank === 1" name="i-lucide-crown" class="rank-icon is-first" />
                        <TownIcon v-else-if="r.rank <= 3" name="i-lucide-medal" class="rank-icon" />
                        <template v-else>#{{ r.rank }}</template>
                    </span>
                    <div class="size-9 shrink-0"><TownFace :image="r.image" :name="r.name" /></div>
                    <div class="min-w-0 flex-1">
                        <div class="mayor-name">
                            <span class="truncate">{{ r.name }}</span>
                            <span v-if="r.title" class="mayor-title">{{ r.title }}</span>
                        </div>
                        <div class="mayor-sub">
                            <span><TownIcon name="i-lucide-map" class="sub-icon" /> {{ r.plots }}</span>
                            <span><TownIcon name="i-lucide-building-2" class="sub-icon" /> {{ r.buildings }}</span>
                            <span><TownIcon name="i-lucide-users" class="sub-icon" /> {{ r.popCap }}</span>
                            <span>tier {{ r.maxTier }}</span>
                        </div>
                    </div>
                    <div class="mayor-income">
                        <TownCoin /> {{ formatNumber(r.incomePerDay) }}<span class="mayor-per">/day</span>
                    </div>
                </div>
            </div>
        </div>
        <div v-if="me && !meListed" class="mayor-foot">
            You are <b>#{{ me.rank }}</b> · <TownCoin /> <b>{{ formatNumber(me.incomePerDay) }}</b>/day
        </div>
    </div>
</template>

<style scoped>
.mayor { align-items: center; gap: 12px; background: var(--g-fill); border: 1px solid transparent; }
.mayor.is-me {
    background: color-mix(in srgb, var(--g-accent) 12%, transparent);
    border-color: color-mix(in srgb, var(--g-accent) 45%, transparent);
}
.mayor-rank {
    width: 30px; flex-shrink: 0;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums;
    color: var(--g-muted);
}
.rank-icon { width: 17px; height: 17px; color: var(--g-muted); }
.rank-icon.is-first { color: var(--g-gold); }

.mayor-name { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; min-width: 0; }
.mayor-title { flex-shrink: 0; font-size: 10px; font-weight: 600; color: var(--g-muted); }
.mayor-sub {
    margin-top: 1px;
    display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px;
    font-size: 11px; color: var(--g-muted); font-variant-numeric: tabular-nums;
}
.mayor-sub > span { display: inline-flex; align-items: center; gap: 3px; }
.sub-icon { width: 12px; height: 12px; flex-shrink: 0; }

.mayor-income {
    flex-shrink: 0;
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums;
    color: var(--g-green);
}
.mayor-per { color: var(--g-muted); font-weight: 500; }

.mayor-foot {
    padding: 8px 16px;
    border-top: 1px solid var(--g-line);
    text-align: center;
    font-size: 11.5px; color: var(--g-text-2);
    font-variant-numeric: tabular-nums;
}
</style>
