import { toast } from 'vue-sonner'
import { PirateGame } from '~/utils/pirate-raid/engine'
import type {
    PirateAnnouncement, PirateGameOverResult, PirateHudState, PirateShipStats, PirateSoundEvent, SoundOptions
} from '~/utils/pirate-raid/engine/types'
import type { PirateAbilityId } from '#shared/pirate-raid/rules'
import type { PirateFinishRunResponse, PirateStartRunResponse } from '#shared/pirate-raid/api'

const pirateSound = usePirateSound()

// ─── Shared pirate-voyage state ────────────────────────────────────────────
// Navigating between /pirates and /pirates/manage unmounts and remounts the
// page component, but a live voyage shouldn't die just because the player
// popped into the armory. So the PirateGame instance and every bit of UI
// state it drives live here, at module scope, outside any single page's
// lifecycle: a page just attaches/detaches its canvas host and pauses or
// resumes the engine, it never destroys it. Only a genuine full reload (or a
// closed tab) actually loses this in-memory state, in which case
// server/api/pirates/finish-run.post.ts's `abandoned` path clears the stale
// server-side voyage the next time /pirates mounts fresh.

interface PirateStateSnapshot {
    activeRun: unknown
    equippedSkinId: string
    equippedAbilityId: PirateAbilityId
    equippedAbilityLevel: number
    stats: { maxHp: number, speed: number, defenseRating: number, regenRate: number }
    ammo: { capacity: number }
    cannons: { slotIndex: number, tierId: string, attackRating: number, maxDamage: number, reloadMs: number, range: number, shotColor: number, shotTrail: boolean }[]
}

/** The engine's end-of-voyage report plus what the server actually paid. */
export interface PirateGameOverInfo extends PirateGameOverResult {
    awarded: number
    survivalPay: number
    completionBonus: number
    firstClearBounty: number
    difficulty: number
    completed: boolean
}

export interface PirateLiveAnnouncement extends PirateAnnouncement {
    id: number
}

/** How long each kind of floating card stays up. */
const ANNOUNCE_MS: Record<PirateAnnouncement['kind'], number> = {
    boss: 2200,
    upgrade: 3400,
    crate: 2600,
    repair: 2200,
    warning: 3000
}
const MAX_ANNOUNCEMENTS = 3

/** Letters of Marque multiplier for the voyage in progress. */
let payMultiplier = 1
const hud = shallowRef<PirateHudState | null>(null)
const running = ref(false)
const paused = ref(false)
const starting = ref(false)
const announcements = ref<PirateLiveAnnouncement[]>([])
let announceSeq = 0

const gameOverVisible = ref(false)
const gameOverResult = ref<PirateGameOverInfo | null>(null)
const submitting = ref(false)

let game: PirateGame | null = null
let resizeObserver: ResizeObserver | null = null
let lastTension = -1

// Rebound on every attachCanvas() call (i.e. every time a page mounts), so an
// engine callback that fires later (after the player has navigated to a
// different page and back) reaches the currently mounted page's refresh rather
// than a stale closure from an earlier mount.
let currentRefresh: (() => Promise<unknown>) | null = null

function setTension(value: number) {
    if (value === lastTension) return
    lastTension = value
    pirateSound.setTension(value)
}

function announce(announcement: PirateAnnouncement) {
    // Crates are visible on the sea (glowing in their rarity colour) and a
    // collected upgrade appears in the HUD row, hover it for details. Cards
    // for either in the middle of the sea only got in the way.
    if (announcement.kind === 'upgrade' || announcement.kind === 'crate') return
    const id = announceSeq++
    // A newer card of the same kind replaces the old one (two crate notices
    // in a row, or a second boss) rather than stacking up copies.
    const others = announcements.value.filter(item => item.kind !== announcement.kind || announcement.kind === 'upgrade')
    announcements.value = [...others, { ...announcement, id }].slice(-MAX_ANNOUNCEMENTS)
    setTimeout(() => {
        announcements.value = announcements.value.filter(item => item.id !== id)
    }, ANNOUNCE_MS[announcement.kind])
}

function dismissAnnouncement(id: number) {
    announcements.value = announcements.value.filter(item => item.id !== id)
}

async function handleGameOver(result: PirateGameOverResult) {
    pirateSound.stopAmbience()
    pirateSound.play('maelstrom-loop-stop')
    setTension(0)
    running.value = false
    paused.value = false
    announcements.value = []
    submitting.value = true
    try {
        const res = await apiPost<PirateFinishRunResponse>('/api/pirates/finish-run', {
            survived: result.survived,
            elapsedMs: result.elapsedMs,
            kills: result.kills,
            shotsFired: result.shotsFired,
            reason: result.reason
        })
        gameOverResult.value = {
            ...result,
            elapsedMs: res.elapsedMs,
            awarded: res.awarded,
            survivalPay: res.survivalPay,
            completionBonus: res.completionBonus,
            firstClearBounty: res.firstClearBounty,
            difficulty: res.difficulty,
            completed: res.completed
        }
        gameOverVisible.value = true
        await currentRefresh?.()
    } catch (e: unknown) {
        toast.error(apiErrorMessage(e, 'Failed to submit voyage results'))
    } finally {
        submitting.value = false
    }
}

function buildCallbacks() {
    return {
        onHud: (next: PirateHudState) => {
            // The sim knows base survival pay; Letters of Marque scale it on
            // the server at settlement, so the HUD applies the same factor.
            hud.value = payMultiplier === 1 ? next : { ...next, pay: Math.floor(next.pay * payMultiplier) }
            if (running.value) setTension(next.bosses.length ? 1 : 0.35)
        },
        onGameOver: (result: PirateGameOverResult) => { handleGameOver(result) },
        onAnnounce: (announcement: PirateAnnouncement) => announce(announcement),
        onSound: (sound: PirateSoundEvent, options?: SoundOptions) => pirateSound.play(sound, options)
    }
}

function statsFromState(state: PirateStateSnapshot): PirateShipStats {
    return {
        maxHp: state.stats.maxHp,
        speed: state.stats.speed,
        defenseRating: state.stats.defenseRating,
        regenRate: state.stats.regenRate,
        ammo: state.ammo.capacity,
        skinId: state.equippedSkinId,
        abilityId: state.equippedAbilityId,
        abilityLevel: state.equippedAbilityLevel ?? 1,
        cannons: state.cannons.map(c => ({ slotIndex: c.slotIndex, tierId: c.tierId, attackRating: c.attackRating, maxDamage: c.maxDamage, reloadMs: c.reloadMs, range: c.range, shotColor: c.shotColor, shotTrail: c.shotTrail }))
    }
}

function setupResizeObserver(host: HTMLDivElement) {
    resizeObserver?.disconnect()
    resizeObserver = new ResizeObserver(() => {
        if (game) game.resize(host.clientWidth, host.clientHeight)
    })
    resizeObserver.observe(host)
}

export function usePirateRun() {
    function registerRefresh(refresh: () => Promise<unknown>) {
        currentRefresh = refresh
    }

    /**
     * Called from the page's onMounted. Reattaches a still-live (paused)
     * voyage's canvas if one exists; otherwise mounts a fresh engine, clearing
     * a stale server-side lock first if this turns out to be a genuine reload
     * after a closed tab. `stateRef` is passed as a ref (not a snapshot) so
     * that if we do abandon-and-refresh below, we build the fresh engine off
     * the refetched data rather than a stale copy.
     */
    async function attachCanvas(host: HTMLDivElement, stateRef: Ref<PirateStateSnapshot | null | undefined>, refresh: () => Promise<unknown>) {
        registerRefresh(refresh)

        if (game) {
            if (stateRef.value?.equippedSkinId) game.setPlayerSkin(stateRef.value.equippedSkinId)
            game.attach(host)
            game.resize(host.clientWidth, host.clientHeight)
            setupResizeObserver(host)
            return
        }

        if (!stateRef.value) return

        if (stateRef.value.activeRun) {
            try {
                await apiPost('/api/pirates/finish-run', { survived: false, abandoned: true })
                await refresh()
            } catch {
                // ignore: the state still shows the voyage if this failed
            }
        }

        const state = stateRef.value
        if (!state) return
        game = new PirateGame(buildCallbacks(), statsFromState(state))
        await game.mount(host)
        game.resize(host.clientWidth, host.clientHeight)
        setupResizeObserver(host)
    }

    /** Called from the page's onUnmounted. Freezes a running voyage in place instead of tearing it down. */
    function detachCanvas() {
        resizeObserver?.disconnect()
        resizeObserver = null
        if (game && running.value) {
            game.pause()
            pirateSound.stopEffects()
            // The page owns the sea ambience. Tear it down rather than merely
            // pausing it so nothing keeps playing on unrelated pages.
            pirateSound.stopAmbience()
            pirateSound.play('maelstrom-loop-stop')
            setTension(0)
            running.value = false
            paused.value = true
        }
    }

    async function startVoyage(state: PirateStateSnapshot, difficulty: number) {
        if (!game || running.value || paused.value || starting.value) return
        if (state.cannons.length === 0) return
        starting.value = true
        try {
            const res = await apiPost<PirateStartRunResponse>('/api/pirates/start-run', { difficulty })
            payMultiplier = res.payMultiplier
            announcements.value = []
            gameOverVisible.value = false
            gameOverResult.value = null
            hud.value = null
            running.value = true
            paused.value = false
            game.start({
                maxHp: res.stats.maxHp,
                speed: res.stats.speed,
                defenseRating: res.stats.defenseRating,
                regenRate: res.stats.regenRate,
                ammo: res.ammo,
                skinId: res.skinId,
                abilityId: res.abilityId,
                abilityLevel: res.abilityLevel,
                cannons: res.cannons
            }, res.power, res.difficulty)
            pirateSound.startAmbience()
            setTension(0.35)
        } catch (e: unknown) {
            running.value = false
            toast.error(apiErrorMessage(e, 'Failed to set sail'))
        } finally {
            starting.value = false
        }
    }

    function pauseVoyage() {
        if (!game || !running.value) return
        game.pause()
        pirateSound.pauseAmbience()
        setTension(0)
        running.value = false
        paused.value = true
    }

    function resumeVoyage() {
        if (!game || !paused.value) return
        game.resume()
        pirateSound.startAmbience()
        paused.value = false
        running.value = true
        setTension(hud.value?.bosses.length ? 1 : 0.35)
    }

    /** Ends the voyage early by player choice: banks the survival pay earned so far. */
    function cancelVoyage() {
        game?.cancel()
    }

    function castAbility() {
        if (running.value) game?.castAbility()
    }

    function closeGameOver() {
        gameOverVisible.value = false
    }

    return {
        hud,
        running,
        paused,
        starting,
        submitting,
        announcements,
        dismissAnnouncement,
        gameOverVisible,
        gameOverResult,
        registerRefresh,
        attachCanvas,
        detachCanvas,
        startVoyage,
        pauseVoyage,
        resumeVoyage,
        cancelVoyage,
        castAbility,
        closeGameOver,
        soundEnabled: pirateSound.soundEnabled,
        soundVolume: pirateSound.soundVolume,
        playMenuSound: () => pirateSound.play('menu')
    }
}
