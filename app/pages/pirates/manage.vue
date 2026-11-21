<script setup lang="ts">
import { toast } from 'vue-sonner'
import type { PirateAbilityView, PirateSkinView, PirateStateResponse } from '#shared/pirate-raid/api'
import { pirateCannonCost } from '#shared/pirate-raid/economy'
import {
    PIRATE_SHIP_STAT_IDS, PIRATE_CANNON_TIERS, PIRATE_MAX_CANNON_SLOTS,
    pirateMaxHp, pirateShipSpeed, pirateDefenseRating, pirateAmmoCapacity, pirateRegenRate,
    pirateStatMaxLevel, pirateCannonDps, pirateCannonTier,
    type PirateShipStatId
} from '#shared/pirate-raid/rules'
import { pirateAbilityHex, pirateHex } from '~/utils/pirate-raid/ui'

const { data: state, refresh } = await useAsyncData('pirate-state', () => apiFetch<PirateStateResponse>('/api/pirates/state'))
const doubloons = computed(() => state.value?.doubloons ?? 0)
// Skin previews carry the guns actually fitted, so the shipyard shows your ship.
const loadoutGunTiers = computed(() => state.value?.cannons.map(cannon => cannon.tierId) ?? [])

// Reference defense used only to compare cannon tiers in the shop: an
// approximate mid-game target, not tied to any real enemy.
const DPS_REFERENCE_DEFENSE = 20

const STAT_META: Record<PirateShipStatId, { label: string, icon: string, color: string, value: (level: number) => number, unit: string }> = {
    hull: { label: 'Hull', icon: 'i-lucide-heart', color: '#f0524f', value: l => pirateMaxHp(l), unit: 'HP' },
    speed: { label: 'Speed', icon: 'i-lucide-wind', color: '#2dd4bf', value: l => pirateShipSpeed(l), unit: 'spd' },
    defense: { label: 'Armour', icon: 'i-lucide-shield', color: '#6cb8ff', value: l => pirateDefenseRating(l), unit: 'def' },
    ammoCapacity: { label: 'Powder Hold', icon: 'i-lucide-package', color: '#f3c35a', value: l => pirateAmmoCapacity(l), unit: 'shot' },
    regen: { label: 'Repairs', icon: 'i-lucide-heart-pulse', color: '#fb7185', value: l => pirateRegenRate(l), unit: 'HP/5s' }
}

const statMaxLevel = (statId: PirateShipStatId) => pirateStatMaxLevel(statId)

// Each tier glows in its own shot colour, the same colour its barrel tip burns at sea.
function tierHex(tierId: string) {
    return pirateHex(pirateCannonTier(tierId).shotColor)
}

const upgrading = ref<PirateShipStatId | 'marque' | null>(null)
const unlockingSlot = ref(false)
const equipping = ref<string | null>(null)
const sellingSlot = ref<number | null>(null)
const swapping = ref(false)
const skinAction = ref<string | null>(null)
const abilityAction = ref<string | null>(null)

// Swap mode: pick a source port, then pick a destination.
const swapSource = ref<number | null>(null)

const pickerOpen = ref(false)
const pickerSlot = ref<number | null>(null)
const pickerCurrentTier = computed(() => {
    if (pickerSlot.value === null || !state.value) return null
    return state.value.cannons.find(c => c.slotIndex === pickerSlot.value) ?? null
})

const cannonsBySlot = computed(() => {
    const map = new Map<number, PirateStateResponse['cannons'][number]>()
    for (const c of state.value?.cannons ?? []) map.set(c.slotIndex, c)
    return map
})

const slots = computed(() => Array.from({ length: PIRATE_MAX_CANNON_SLOTS }, (_, i) => i))

const totalDps = computed(() => {
    if (!state.value) return 0
    return state.value.cannons.reduce((sum, c) => {
        const tier = PIRATE_CANNON_TIERS.find(t => t.id === c.tierId)
        return sum + (tier ? pirateCannonDps(tier, DPS_REFERENCE_DEFENSE) : 0)
    }, 0)
})

const bestRange = computed(() => state.value?.cannons.reduce((max, c) => Math.max(max, c.range), 0) ?? 0)
const maxTierDps = computed(() => Math.max(...PIRATE_CANNON_TIERS.map(t => pirateCannonDps(t, DPS_REFERENCE_DEFENSE))))

function tierDps(tierId: string) {
    const tier = PIRATE_CANNON_TIERS.find(t => t.id === tierId)
    return tier ? pirateCannonDps(tier, DPS_REFERENCE_DEFENSE) : 0
}

/** What fitting a tier in the open port costs after trading in the gun already there. */
function fitCost(tierId: string) {
    return pirateCannonCost(tierId) - (pickerCurrentTier.value?.tradeIn ?? 0)
}

function statDelta(tier: typeof PIRATE_CANNON_TIERS[number], key: 'attackRating' | 'maxDamage' | 'range') {
    if (!pickerCurrentTier.value) return null
    return tier[key] - pickerCurrentTier.value[key]
}

function closePickerOnEscape(event: KeyboardEvent) {
    if (event.key === 'Escape') pickerOpen.value = false
}
onMounted(() => window.addEventListener('keydown', closePickerOnEscape))
onUnmounted(() => window.removeEventListener('keydown', closePickerOnEscape))

function openPicker(slotIndex: number) {
    swapSource.value = null
    pickerSlot.value = slotIndex
    pickerOpen.value = true
}

function handlePortClick(slotIndex: number) {
    if (swapSource.value === null) return
    if (swapSource.value === slotIndex) {
        swapSource.value = null
        return
    }
    swapCannons(swapSource.value, slotIndex)
}

/** POST, refresh the armory, and show the error if it failed. */
async function act(url: string, body: Record<string, unknown>, fallback: string) {
    try {
        await apiPost(url, body)
        await refresh()
        return true
    } catch (e: unknown) {
        toast.error(apiErrorMessage(e, fallback))
        return false
    }
}

async function swapCannons(slotA: number, slotB: number) {
    if (swapping.value) return
    swapping.value = true
    await act('/api/pirates/cannons/swap', { slotA, slotB }, 'Failed to swap cannons')
    swapping.value = false
    swapSource.value = null
}

async function upgradeStat(stat: PirateShipStatId) {
    if (upgrading.value) return
    upgrading.value = stat
    await act('/api/pirates/upgrade', { stat }, 'Upgrade failed')
    upgrading.value = null
}

async function signMarque() {
    if (upgrading.value) return
    upgrading.value = 'marque'
    await act('/api/pirates/marque/upgrade', {}, 'Failed to sign the letters')
    upgrading.value = null
}

async function unlockSlot() {
    if (unlockingSlot.value) return
    unlockingSlot.value = true
    await act('/api/pirates/slots/unlock', {}, 'Failed to open the port')
    unlockingSlot.value = false
}

async function equipCannon(tierId: string) {
    if (pickerSlot.value === null || equipping.value) return
    equipping.value = tierId
    if (await act('/api/pirates/cannons/fit', { slotIndex: pickerSlot.value, tierId }, 'Failed to fit the cannon')) pickerOpen.value = false
    equipping.value = null
}

async function sellCannon(slotIndex: number) {
    if (sellingSlot.value !== null) return
    sellingSlot.value = slotIndex
    await act('/api/pirates/cannons/sell', { slotIndex }, 'Failed to sell the cannon')
    sellingSlot.value = null
}

async function selectSkin(skin: PirateSkinView) {
    if (skin.equipped || skinAction.value) return
    skinAction.value = skin.id
    await act(skin.owned ? '/api/pirates/skins/equip' : '/api/pirates/skins/buy', { skinId: skin.id }, 'Failed to change the ship')
    skinAction.value = null
}

async function selectAbility(ability: PirateAbilityView) {
    if (ability.equipped || abilityAction.value) return
    abilityAction.value = ability.id
    await act(ability.owned ? '/api/pirates/abilities/equip' : '/api/pirates/abilities/buy', { abilityId: ability.id }, 'Failed to change the ability')
    abilityAction.value = null
}

async function upgradeAbility(ability: PirateAbilityView) {
    if (!ability.owned || ability.upgradeCost === null || abilityAction.value) return
    abilityAction.value = ability.id
    await act('/api/pirates/abilities/upgrade', { abilityId: ability.id }, 'Failed to upgrade the ability')
    abilityAction.value = null
}
</script>

<template>
  <div class="mx-auto w-full max-w-7xl space-y-8 px-3 sm:px-6">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <h1 class="pr-display text-5xl leading-none sm:text-6xl">
        Armory
      </h1>
      <div class="flex flex-wrap items-center gap-2">
        <span v-if="state" class="pr-tag" style="--tag: #f3c35a"><PiratesIcon name="i-lucide-anchor" class="size-3" />Power {{ state.power }}</span>
        <div class="pr-inset px-3 py-1.5 text-sm font-bold" title="Doubloons">
          <PiratesDoubloons :value="doubloons" />
        </div>
      </div>
    </header>

    <div v-if="!state" class="space-y-4">
      <div class="pr-skeleton h-72" />
      <div class="pr-skeleton h-48" />
    </div>

    <template v-else>
      <p v-if="state.activeRun" class="pr-inset flex items-center gap-2 px-3 py-2 text-xs text-[var(--pr-gold)]">
        <PiratesIcon name="i-lucide-sailboat" class="size-4" />
        Voyage at sea
      </p>

      <!-- ══ Gun deck ═══════════════════════════════════════════════════ -->
      <section class="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)]">
        <div class="pr-panel overflow-hidden">
          <div class="armory-dock h-56 sm:h-64">
            <PiratesShipPreview :skin-id="state.equippedSkinId" :gun-tier-ids="loadoutGunTiers" animate class="size-full" />
          </div>
          <div class="grid grid-cols-3 gap-2 p-4 text-center">
            <div class="pr-inset py-2">
              <p class="pr-dim text-[9px] font-bold uppercase tracking-wider">Guns</p>
              <p class="text-lg font-black">{{ state.cannons.length }}<span class="pr-dim text-xs">/{{ state.cannonSlots }}</span></p>
            </div>
            <div class="pr-inset py-2">
              <p class="pr-dim text-[9px] font-bold uppercase tracking-wider">DPS</p>
              <p class="text-lg font-black">{{ totalDps.toFixed(1) }}</p>
            </div>
            <div class="pr-inset py-2">
              <p class="pr-dim text-[9px] font-bold uppercase tracking-wider">Range</p>
              <p class="text-lg font-black">{{ bestRange }}</p>
            </div>
          </div>
        </div>

        <div>
          <div class="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 class="pr-display text-3xl leading-none">
                Gun deck
              </h2>
              <p class="pr-muted text-xs">
                {{ state.cannonSlots }}/{{ PIRATE_MAX_CANNON_SLOTS }}
              </p>
            </div>
          </div>

          <p v-if="swapSource !== null" class="pr-inset mb-2 px-3 py-2 text-xs text-[var(--pr-teal)]">
            Moving port {{ swapSource + 1 }}
          </p>

          <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <div
              v-for="slotIndex in slots"
              :key="slotIndex"
              class="armory-port"
              :class="{
                'is-locked': slotIndex >= state.cannonSlots,
                'is-source': swapSource === slotIndex,
                'is-target': swapSource !== null && swapSource !== slotIndex && slotIndex < state.cannonSlots
              }"
              :style="cannonsBySlot.get(slotIndex) ? { '--gun': tierHex(cannonsBySlot.get(slotIndex)!.tierId) } : undefined"
              @click="slotIndex < state.cannonSlots ? handlePortClick(slotIndex) : undefined"
            >
              <span class="armory-port-no">{{ slotIndex + 1 }}</span>

              <template v-if="slotIndex >= state.cannonSlots">
                <PiratesIcon name="i-lucide-lock" class="mx-auto size-6 pr-dim" />
                <PiratesButton
                  v-if="slotIndex === state.cannonSlots"
                  size="sm"
                  variant="wood"
                  block
                  :disabled="!!state.activeRun || !state.nextSlotCost || doubloons < (state.nextSlotCost ?? 0)"
                  :loading="unlockingSlot"
                  @click.stop="unlockSlot"
                >
                  <PiratesDoubloons :value="state.nextSlotCost ?? 0" />
                </PiratesButton>
              </template>

              <template v-else-if="cannonsBySlot.get(slotIndex)">
                <PiratesCannonArt :tier-id="cannonsBySlot.get(slotIndex)!.tierId" class="mx-auto w-24" />
                <p class="truncate text-center text-sm font-black" :style="{ color: 'var(--gun)' }">
                  {{ cannonsBySlot.get(slotIndex)!.name }}
                </p>
                <div class="pr-bar h-1.5">
                  <i :style="{ 'width': `${Math.max(4, (tierDps(cannonsBySlot.get(slotIndex)!.tierId) / maxTierDps) * 100)}%`, '--fill': 'var(--gun)' }" />
                </div>
                <div class="pr-muted grid grid-cols-2 gap-x-2 text-[10px]">
                  <span>{{ cannonsBySlot.get(slotIndex)!.attackRating }} atk</span>
                  <span class="text-right">{{ cannonsBySlot.get(slotIndex)!.maxDamage }} dmg</span>
                  <span>{{ (cannonsBySlot.get(slotIndex)!.reloadMs / 1000).toFixed(1) }}s</span>
                  <span class="text-right">{{ cannonsBySlot.get(slotIndex)!.range }} rng</span>
                </div>
                <div class="flex gap-1">
                  <PiratesButton size="sm" variant="wood" class="flex-1" :disabled="!!state.activeRun || swapSource !== null" label="Refit" @click.stop="openPicker(slotIndex)" />
                  <PiratesButton
                    size="sm"
                    variant="ghost"
                    icon="i-lucide-arrow-left-right"
                    :disabled="!!state.activeRun || state.cannonSlots < 2 || swapping"
                    aria-label="Move gun"
                    @click.stop="swapSource = swapSource === slotIndex ? null : slotIndex"
                  />
                  <PiratesButton
                    size="sm"
                    variant="ghost"
                    icon="i-lucide-trash-2"
                    :disabled="!!state.activeRun || swapSource !== null"
                    :loading="sellingSlot === slotIndex"
                    :title="`Sell for ${cannonsBySlot.get(slotIndex)!.tradeIn}`"
                    aria-label="Sell gun"
                    @click.stop="sellCannon(slotIndex)"
                  />
                </div>
              </template>

              <template v-else>
                <PiratesIcon name="i-lucide-crosshair" class="mx-auto size-6 pr-muted" />
                <PiratesButton v-if="swapSource === null" size="sm" variant="gold" block :disabled="!!state.activeRun" label="Fit gun" @click.stop="openPicker(slotIndex)" />
                <p v-else class="text-center text-[11px] text-[var(--pr-teal)]">
                  Move here
                </p>
              </template>
            </div>
          </div>
        </div>
      </section>

      <!-- ══ Shipwright ═════════════════════════════════════════════════ -->
      <section>
        <h2 class="pr-display mb-3 text-3xl leading-none">
          Hull &amp; systems
        </h2>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <div v-for="statId in PIRATE_SHIP_STAT_IDS" :key="statId" class="pr-panel p-4" :style="{ '--stat': STAT_META[statId].color }">
            <div class="mb-3 flex items-center gap-3">
              <div class="grid size-10 shrink-0 place-items-center rounded-full pr-glow" :style="{ '--glow': STAT_META[statId].color, 'color': STAT_META[statId].color }">
                <PiratesIcon :name="STAT_META[statId].icon" class="size-5" />
              </div>
              <div class="min-w-0">
                <p class="truncate font-bold">
                  {{ STAT_META[statId].label }}
                </p>
                <p class="pr-dim text-[11px]">
                  Level {{ state.levels[statId] }} of {{ statMaxLevel(statId) }}
                </p>
              </div>
            </div>
            <div class="mb-3 flex gap-0.5">
              <span
                v-for="i in statMaxLevel(statId)"
                :key="i"
                class="h-1.5 flex-1 rounded-full"
                :style="{ background: i <= state.levels[statId] ? STAT_META[statId].color : 'rgba(255,255,255,0.08)', boxShadow: i <= state.levels[statId] ? `0 0 6px ${STAT_META[statId].color}` : 'none' }"
              />
            </div>
            <p class="mb-3 text-sm">
              <b>{{ STAT_META[statId].value(state.levels[statId]) }}</b> <span class="pr-dim text-xs">{{ STAT_META[statId].unit }}</span>
              <template v-if="state.levels[statId] < statMaxLevel(statId)">
                <PiratesIcon name="i-lucide-arrow-right" class="mx-1 inline size-3 pr-dim" />
                <b class="text-[var(--pr-emerald)]">{{ STAT_META[statId].value(state.levels[statId] + 1) }}</b>
              </template>
            </p>
            <PiratesButton
              block
              size="sm"
              :variant="state.levels[statId] >= statMaxLevel(statId) ? 'ghost' : 'gold'"
              :disabled="!!state.activeRun || state.levels[statId] >= statMaxLevel(statId) || doubloons < (state.costs[statId] ?? 0)"
              :loading="upgrading === statId"
              @click="upgradeStat(statId)"
            >
              <span v-if="state.levels[statId] >= statMaxLevel(statId)">Maxed</span>
              <PiratesDoubloons v-else :value="state.costs[statId] ?? 0" />
            </PiratesButton>
          </div>
        </div>
      </section>

      <!-- ══ Letters of Marque ══════════════════════════════════════════ -->
      <section>
        <div class="pr-panel flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:p-5" style="--stat: #f3c35a">
          <div class="flex min-w-0 flex-1 items-center gap-4">
            <div class="grid size-12 shrink-0 place-items-center rounded-full pr-glow" style="--glow: #f3c35a; color: #f3c35a">
              <PiratesIcon name="i-lucide-scroll-text" class="size-6" />
            </div>
            <div class="min-w-0">
              <p class="pr-display text-2xl leading-none">
                Letters of Marque <span class="pr-dim font-sans text-sm font-bold">{{ state.marque.level }} / {{ state.marque.maxLevel }}</span>
              </p>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-4">
            <p class="text-sm font-black whitespace-nowrap">
              <span class="text-[var(--pr-emerald)]" title="Voyage pay">+{{ Math.round((state.marque.multiplier - 1) * 100) }}%</span>
              <template v-if="state.marque.nextMultiplier">
                <PiratesIcon name="i-lucide-arrow-right" class="mx-1 inline size-3 pr-dim" />
                <span class="text-[var(--pr-emerald)]">+{{ Math.round((state.marque.nextMultiplier - 1) * 100) }}%</span>
              </template>
            </p>
            <div class="flex gap-1">
              <span
                v-for="i in state.marque.maxLevel"
                :key="i"
                class="size-1.5 rounded-full"
                :style="{ background: i <= state.marque.level ? '#f3c35a' : 'rgba(255,255,255,0.12)', boxShadow: i <= state.marque.level ? '0 0 6px #f3c35a' : 'none' }"
              />
            </div>
            <PiratesButton
              size="sm"
              class="min-w-32"
              :variant="state.marque.cost === null ? 'ghost' : 'gold'"
              :disabled="!!state.activeRun || state.marque.cost === null || doubloons < (state.marque.cost ?? 0)"
              :loading="upgrading === 'marque'"
              @click="signMarque"
            >
              <span v-if="state.marque.cost === null">Maxed</span>
              <template v-else>
                Sign · <PiratesDoubloons :value="state.marque.cost" />
              </template>
            </PiratesButton>
          </div>
        </div>
      </section>

      <!-- ══ Abilities ══════════════════════════════════════════════════ -->
      <section>
        <div class="mb-3">
          <h2 class="pr-display text-3xl leading-none">
            Captain's arsenal
          </h2>
        </div>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div
            v-for="ability in state.abilities"
            :key="ability.id"
            class="pr-panel flex flex-col p-4"
            :class="{ 'pr-glow': ability.equipped }"
            :style="{ '--glow': pirateAbilityHex(ability.id) }"
          >
            <div class="flex items-start gap-3">
              <PiratesAbilityArt :id="ability.id" class="size-16 shrink-0" :dimmed="!ability.owned" :animated="ability.equipped" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center justify-between gap-2">
                  <p class="pr-display truncate text-2xl leading-tight" :style="{ color: pirateAbilityHex(ability.id) }">
                    {{ ability.name }}
                  </p>
                  <span v-if="ability.equipped" class="pr-tag" :style="{ '--tag': pirateAbilityHex(ability.id) }">Equipped</span>
                  <span v-else-if="ability.owned" class="pr-tag" style="--tag: #3ddc97">Owned</span>
                </div>
                <p class="pr-muted mt-1 text-[11px] leading-snug">
                  {{ ability.description }}
                </p>
              </div>
            </div>
            <div class="mt-3 flex items-center gap-2 text-[11px]">
              <PiratesIcon name="i-lucide-timer" class="size-3.5 pr-dim" />
              <span>{{ ability.currentCooldownMs / 1000 }}s cooldown</span>
              <span v-if="ability.currentCooldownMs > ability.bestCooldownMs" class="pr-dim">→ {{ ability.bestCooldownMs / 1000 }}s at max</span>
            </div>
            <div v-if="ability.owned" class="mt-2 flex items-center gap-2">
              <span class="text-[11px] font-bold">Lv {{ ability.level }}</span>
              <div class="flex flex-1 gap-0.5">
                <span
                  v-for="pip in ability.maxLevel"
                  :key="pip"
                  class="h-1.5 flex-1 rounded-full"
                  :style="{ background: pip <= ability.level ? pirateAbilityHex(ability.id) : 'rgba(255,255,255,0.08)' }"
                />
              </div>
            </div>
            <div class="mt-auto flex gap-2 pt-3">
              <PiratesButton
                class="flex-1"
                size="sm"
                :variant="ability.equipped ? 'ghost' : ability.owned ? 'wood' : 'gold'"
                :disabled="!!state.activeRun || ability.equipped || (!ability.owned && doubloons < ability.cost)"
                :loading="abilityAction === ability.id"
                @click="selectAbility(ability)"
              >
                <span v-if="ability.equipped">Equipped</span>
                <span v-else-if="ability.owned">Equip</span>
                <span v-else-if="ability.cost === 0">Free</span>
                <PiratesDoubloons v-else :value="ability.cost" />
              </PiratesButton>
              <PiratesButton
                v-if="ability.owned"
                class="flex-1"
                size="sm"
                variant="teal"
                icon="i-lucide-arrow-big-up-dash"
                :disabled="!!state.activeRun || ability.upgradeCost === null || doubloons < ability.upgradeCost"
                :loading="abilityAction === ability.id"
                @click="upgradeAbility(ability)"
              >
                <span v-if="ability.upgradeCost === null">Max</span>
                <PiratesDoubloons v-else :value="ability.upgradeCost" :show-icon="false" />
              </PiratesButton>
            </div>
          </div>
        </div>
      </section>

      <!-- ══ Shipyard ═══════════════════════════════════════════════════ -->
      <section>
        <div class="mb-3">
          <h2 class="pr-display text-3xl leading-none">
            Shipyard
          </h2>
        </div>
        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <div
            v-for="skin in state.skins"
            :key="skin.id"
            class="pr-panel flex flex-col overflow-hidden"
            :class="{ 'pr-glow': skin.equipped }"
            style="--glow: #f3c35a"
          >
            <div class="armory-dock relative h-32">
              <PiratesShipPreview :skin-id="skin.id" :gun-tier-ids="loadoutGunTiers" :animate="skin.equipped" class="size-full" />
              <span v-if="skin.equipped" class="pr-tag absolute right-3 top-3">At the helm</span>
              <span v-else-if="skin.owned" class="pr-tag absolute right-3 top-3" style="--tag: #3ddc97">Owned</span>
            </div>
            <div class="flex flex-1 flex-col p-4">
              <p class="truncate font-black" :class="skin.id === 'crown-of-tides' ? 'pr-gold' : ''">
                {{ skin.name }}
              </p>
              <p class="pr-muted mt-1 flex-1 text-[11px] leading-snug">
                {{ skin.description }}
              </p>
              <PiratesButton
                block
                size="sm"
                class="mt-3"
                :variant="skin.equipped ? 'ghost' : skin.owned ? 'wood' : 'gold'"
                :disabled="!!state.activeRun || skin.equipped || (!skin.owned && doubloons < skin.cost)"
                :loading="skinAction === skin.id"
                @click="selectSkin(skin)"
              >
                <span v-if="skin.equipped">At the helm</span>
                <span v-else-if="skin.owned">Equip</span>
                <span v-else-if="skin.cost === 0">Free</span>
                <PiratesDoubloons v-else :value="skin.cost" />
              </PiratesButton>
            </div>
          </div>
        </div>
      </section>
    </template>

    <!-- ══ Gun picker ════════════════════════════════════════════════════ -->
    <Teleport to="body">
      <Transition name="armory-modal">
        <div v-if="pickerOpen" class="pirate-theme armory-modal" @click.self="pickerOpen = false">
          <div class="pr-panel armory-modal-card" role="dialog" aria-modal="true">
            <div class="flex items-center justify-between gap-3 px-5 pt-5">
              <h3 class="pr-display text-3xl leading-none">
                {{ pickerCurrentTier ? `Refit port ${(pickerSlot ?? 0) + 1}` : `Arm port ${(pickerSlot ?? 0) + 1}` }}
              </h3>
              <PiratesButton variant="ghost" size="sm" icon="i-lucide-x" aria-label="Close" @click="pickerOpen = false" />
            </div>
            <div class="max-h-[70vh] space-y-2 overflow-y-auto p-5">
              <div
                v-for="tier in PIRATE_CANNON_TIERS"
                :key="tier.id"
                class="armory-tier"
                :class="{ 'is-current': pickerCurrentTier?.tierId === tier.id }"
                :style="{ '--gun': pirateHex(tier.shotColor) }"
              >
                <PiratesCannonArt :tier-id="tier.id" class="w-20 shrink-0" />
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <p class="font-black" :style="{ color: 'var(--gun)' }">
                      {{ tier.name }}
                    </p>
                    <span v-if="pickerCurrentTier?.tierId === tier.id" class="pr-tag">Fitted</span>
                  </div>
                  <div class="pr-bar my-1.5 h-1.5 max-w-52">
                    <i :style="{ 'width': `${Math.max(4, (pirateCannonDps(tier, DPS_REFERENCE_DEFENSE) / maxTierDps) * 100)}%`, '--fill': 'var(--gun)' }" />
                  </div>
                  <div class="pr-muted flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
                    <span>
                      {{ tier.attackRating }} atk
                      <b v-if="statDelta(tier, 'attackRating')" :class="statDelta(tier, 'attackRating')! > 0 ? 'text-[var(--pr-emerald)]' : 'text-[var(--pr-blood)]'">({{ statDelta(tier, 'attackRating')! > 0 ? '+' : '' }}{{ statDelta(tier, 'attackRating') }})</b>
                    </span>
                    <span>
                      {{ tier.maxDamage }} dmg
                      <b v-if="statDelta(tier, 'maxDamage')" :class="statDelta(tier, 'maxDamage')! > 0 ? 'text-[var(--pr-emerald)]' : 'text-[var(--pr-blood)]'">({{ statDelta(tier, 'maxDamage')! > 0 ? '+' : '' }}{{ statDelta(tier, 'maxDamage') }})</b>
                    </span>
                    <span>{{ (tier.reloadMs / 1000).toFixed(1) }}s</span>
                    <span>
                      {{ tier.range }} rng
                      <b v-if="statDelta(tier, 'range')" :class="statDelta(tier, 'range')! > 0 ? 'text-[var(--pr-emerald)]' : 'text-[var(--pr-blood)]'">({{ statDelta(tier, 'range')! > 0 ? '+' : '' }}{{ statDelta(tier, 'range') }})</b>
                    </span>
                    <span class="font-bold text-[var(--pr-ink)]">{{ pirateCannonDps(tier, DPS_REFERENCE_DEFENSE).toFixed(1) }} DPS</span>
                  </div>
                </div>
                <PiratesButton
                  size="sm"
                  :variant="pirateCannonCost(tier.id) === 0 ? 'wood' : 'gold'"
                  :disabled="pickerCurrentTier?.tierId === tier.id || doubloons < fitCost(tier.id)"
                  :loading="equipping === tier.id"
                  :title="pickerCurrentTier ? `${pirateCannonCost(tier.id)} − ${pickerCurrentTier.tradeIn} trade-in` : undefined"
                  @click="equipCannon(tier.id)"
                >
                  <span v-if="pirateCannonCost(tier.id) === 0">Free</span>
                  <PiratesDoubloons v-else :value="Math.max(0, fitCost(tier.id))" />
                </PiratesButton>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.armory-dock {
  background:
    radial-gradient(ellipse at 50% 65%, rgba(45, 212, 191, 0.18), transparent 65%),
    repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.02) 0 1px, transparent 1px 14px),
    linear-gradient(180deg, #0f2b3d, #081723);
  border-bottom: 1px solid rgba(201, 151, 60, 0.35);
}

.armory-port {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  min-height: 11.5rem;
  padding: 0.75rem;
  border-radius: 0.8rem;
  background: linear-gradient(180deg, rgba(58, 38, 22, 0.9), rgba(30, 20, 12, 0.95));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--gun, #c9973c) 45%, transparent), inset 0 1px 0 rgba(255, 226, 154, 0.1);
  justify-content: center;
  transition: box-shadow 0.15s, transform 0.15s;
}
.armory-port.is-locked { background: rgba(0, 0, 0, 0.3); box-shadow: inset 0 0 0 1px rgba(147, 168, 182, 0.15); }
.armory-port.is-source { box-shadow: 0 0 0 2px #2dd4bf, 0 0 20px -6px #2dd4bf; }
.armory-port.is-target { cursor: pointer; box-shadow: 0 0 0 1px rgba(45, 212, 191, 0.6); }
.armory-port.is-target:hover { transform: translateY(-2px); }
.armory-port-no {
  position: absolute;
  top: 0.4rem;
  left: 0.55rem;
  font-family: 'Cinzel', serif;
  font-size: 0.7rem;
  font-weight: 900;
  color: #5f7686;
}
.armory-modal {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: 1rem;
  background: rgba(3, 9, 15, 0.75) !important;
  backdrop-filter: blur(3px);
}
.armory-modal-card { width: 100%; max-width: 34rem; }
.armory-tier {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.7rem 0.8rem;
  border-radius: 0.7rem;
  background: rgba(0, 0, 0, 0.28);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.05);
}
.armory-tier.is-current { box-shadow: inset 0 0 0 1px var(--gun), 0 0 18px -8px var(--gun); }

.armory-modal-enter-active, .armory-modal-leave-active { transition: opacity 0.2s; }
.armory-modal-enter-from, .armory-modal-leave-to { opacity: 0; }
</style>
