import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
    modules: [
        'shadcn-nuxt',
        '@nuxtjs/color-mode',
        '@vueuse/nuxt'
    ],

    // A client-rendered SPA: the games are canvas and WebGL toys behind a
    // session, so there is nothing to server-render.
    ssr: false,

    devtools: { enabled: false },

    // shadcn-nuxt registers app/components/ui itself; everything else
    // auto-registers with its folder as prefix (arcade/Lobby.vue → ArcadeLobby).
    components: [
        { path: '~/components', extensions: ['vue'], ignore: ['ui/**'] }
    ],

    css: ['~/assets/css/main.css'],

    shadcn: {
        prefix: '',
        componentDir: './app/components/ui'
    },

    colorMode: {
        preference: 'dark',
        fallback: 'dark',
        classSuffix: ''
    },

    sourcemap: { server: false, client: false },

    compatibilityDate: '2025-01-15',

    nitro: {
        preset: 'bun',
        logLevel: 2,
        // Dead Front is multiplayer over WebSockets.
        experimental: { websocket: true },
        // bun:sqlite is a Bun builtin; never try to bundle it.
        externals: { external: ['bun:sqlite'] },
        // Tests and scripts exercise server and shared code, so they typecheck
        // with the server project (Nitro globals, bun types). Some also load
        // client game modules (sound cues, model checks), hence the DOM lib.
        typescript: {
            tsConfig: {
                include: ['../test/**/*', '../scripts/**/*'],
                compilerOptions: { types: ['bun'], lib: ['ESNext', 'DOM', 'DOM.Iterable', 'DOM.AsyncIterable'] }
            }
        }
    },

    vite: {
        plugins: [tailwindcss()],
        // Pre-bundle the game engines' dependencies: discovered mid-session,
        // Vite re-optimizes and reloads the page, which ends a running match.
        optimizeDeps: {
            include: [
                'three',
                'three/addons/loaders/GLTFLoader.js',
                'three/addons/utils/BufferGeometryUtils.js',
                'three/examples/jsm/postprocessing/EffectComposer.js',
                'three/examples/jsm/postprocessing/Pass.js',
                'three/examples/jsm/postprocessing/RenderPass.js',
                'three/examples/jsm/postprocessing/ShaderPass.js',
                'three/examples/jsm/postprocessing/UnrealBloomPass.js'
            ]
        },
        build: {
            reportCompressedSize: false,
            // three.js and the game engines are large on purpose.
            chunkSizeWarningLimit: 2_000
        }
    }
})
