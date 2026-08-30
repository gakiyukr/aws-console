<script setup lang="ts">
// 側邊欄頂部標題：僅呈現應用程式 Logo 與名稱，不含任何切換或選單功能
defineProps<{
  name: string
  logo: string
}>()
</script>

<template>
  <SidebarMenu>
    <SidebarMenuItem>
      <div class="flex h-12 items-center gap-2 overflow-hidden rounded-md p-2">
        <div class="aspect-square size-8 shrink-0 flex items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
          <Icon :name="logo" class="size-4" />
        </div>
        <div class="grid flex-1 text-left text-sm leading-tight">
          <span class="truncate font-semibold">{{ name }}</span>
        </div>
      </div>
    </SidebarMenuItem>
  </SidebarMenu>
</template>
