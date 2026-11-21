import type { Component } from 'vue'
import {
    Bomb, Bot, Cctv, ChevronsRight, CircleDollarSign, CircleDot, Clock3, Copy, Crosshair, Flame, Gauge, GitBranch,
    GitFork, HeartPulse, Maximize2, MoveRight, Orbit, RadioTower, Rocket, Shield, ShieldPlus, Skull, Sparkles, Sun,
    Sword, Target, Waves, Zap
} from 'lucide-vue-next'

/** The rules name icons the old way (`i-lucide-bomb`); this maps them to components. */
const ICONS: Record<string, Component> = {
    'i-lucide-bomb': Bomb,
    'i-lucide-bot': Bot,
    'i-lucide-cctv': Cctv,
    'i-lucide-chevrons-right': ChevronsRight,
    'i-lucide-circle-dollar-sign': CircleDollarSign,
    'i-lucide-circle-dot': CircleDot,
    'i-lucide-clock-3': Clock3,
    'i-lucide-copy': Copy,
    'i-lucide-crosshair': Crosshair,
    'i-lucide-flame': Flame,
    'i-lucide-gauge': Gauge,
    'i-lucide-git-branch': GitBranch,
    'i-lucide-git-fork': GitFork,
    'i-lucide-heart-pulse': HeartPulse,
    'i-lucide-maximize-2': Maximize2,
    'i-lucide-move-right': MoveRight,
    'i-lucide-orbit': Orbit,
    'i-lucide-radio-tower': RadioTower,
    'i-lucide-rocket': Rocket,
    'i-lucide-shield': Shield,
    'i-lucide-shield-plus': ShieldPlus,
    'i-lucide-skull': Skull,
    'i-lucide-sparkles': Sparkles,
    'i-lucide-sun': Sun,
    'i-lucide-sword': Sword,
    'i-lucide-target': Target,
    'i-lucide-waves': Waves,
    'i-lucide-zap': Zap
}

export function shapezzIcon(name: string): Component {
    return ICONS[name] ?? Sparkles
}
