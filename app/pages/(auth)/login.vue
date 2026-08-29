<script setup lang="ts">
definePageMeta({
  layout: 'blank',
})

useSeoMeta({
  title: '登入 — AWS 主控台',
})
</script>

<template>
  <LayoutAuth reverse>
    <div class="grid mx-auto max-w-sm gap-6">
      <AuthSignIn />
    </div>
  </LayoutAuth>
</template>
