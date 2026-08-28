<script setup lang="ts">
import type { NavGroup, NavLink, NavSectionTitle } from '~/types/nav'
import { navMenu, navMenuBottom } from '~/constants/menus'

function resolveNavItemComponent(item: NavLink | NavGroup | NavSectionTitle): any {
  if ('children' in item)
    return resolveComponent('LayoutSidebarNavGroup')

  return resolveComponent('LayoutSidebarNavLink')
}

const { data: session } = useFetch<{ authenticated: boolean, user: { username: string, role: string } | null }>('/api/session')
const user = computed(() => ({
  name: session.value?.user?.username || '管理者',
  email: session.value?.user?.role === 'admin' ? '管理者' : session.value?.user?.role || '',
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
      <SidebarGroup class="mt-auto">
        <component :is="resolveNavItemComponent(item)" v-for="(item, index) in navMenuBottom" :key="index" :item="item" size="sm" />
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter>
      <LayoutSidebarNavFooter :user="user" />
    </SidebarFooter>
    <SidebarRail />
  </Sidebar>
</template>
