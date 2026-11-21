<!--
  A game page: the slim bar, then the game filling the rest of the viewport.
  Games that cover the whole window (pointer lock, fullscreen) still sit in
  this box until they ask for more.
-->
<template>
  <div class="flex h-dvh flex-col overflow-hidden">
    <ArcadeTopBar />
    <main class="relative min-h-0 flex-1">
      <slot />
    </main>
  </div>
</template>
