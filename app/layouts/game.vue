<!--
  A game page: the game fills the whole viewport. Games bring their own tabs;
  the hub's bar (or the browser) handles getting back out.
-->
<template>
  <div class="flex h-dvh flex-col overflow-hidden">
    <main class="relative min-h-0 flex-1">
      <slot />
    </main>
  </div>
</template>
