<script setup lang="ts">
import type { NavGroup, NavLink, NavSectionTitle } from '~/types/nav'
import { navMenu } from '~/constants/menus'

function resolveNavItemComponent(item: NavLink | NavGroup | NavSectionTitle): any {
  if ('children' in item)
    return resolveComponent('LayoutSidebarNavGroup')

  return resolveComponent('LayoutSidebarNavLink')
}

// SSR 期間 useFetch 不會自動轉發 cookie，須明確轉發才能在伺服器端
// 取得正確的登入狀態
const { data: session } = useFetch<{ authenticated: boolean, user: { email: string } | null }>('/api/session', {
  headers: useRequestHeaders(['cookie']),
})
const user = computed(() => ({
  name: session.value?.user?.email || '管理者',
  email: 'SSO 登入',
  avatar: '/avatars/avatartion.png',
}))
</script>

<template>
  <Sidebar>
    <SidebarHeader>
      <LayoutSidebarNavHeader
        :teams="[{
          name: 'AWS Console',
          logo: 'i-lucide-cloud-cog',
          plan: 'Workers + D1',
        }]"
      />
    </SidebarHeader>
    <SidebarContent>
      <SidebarGroup v-for="(nav, indexGroup) in navMenu" :key="indexGroup">
        <SidebarGroupLabel v-if="nav.heading">
          {{ nav.heading }}
        </SidebarGroupLabel>
        <component :is="resolveNavItemComponent(item)" v-for="(item, index) in nav.items" :key="index" :item="item" />
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter>
      <LayoutSidebarNavFooter :user="user" />
    </SidebarFooter>
    <SidebarRail />
  </Sidebar>
</template>
