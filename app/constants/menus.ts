import type { NavMenu, NavMenuItems } from '~/types/nav'

export const navMenu: NavMenu[] = [
  {
    heading: '主控台',
    items: [
      {
        title: '機器總覽',
        icon: 'i-lucide-house',
        link: '/',
      },
      {
        title: 'Wavelength 部署',
        icon: 'i-lucide-radio-tower',
        link: '/wavelength',
      },
      {
        title: '操作日誌',
        icon: 'i-lucide-scroll-text',
        link: '/logs',
      },
      {
        title: '帳號管理',
        icon: 'i-lucide-key-round',
        link: '/accounts',
      },
    ],
  },
]

export const navMenuBottom: NavMenuItems = [
  {
    title: '登出',
    icon: 'i-lucide-log-out',
    link: '/logout',
  },
]
