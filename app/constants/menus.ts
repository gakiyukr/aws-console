import type { NavMenu } from '~/types/nav'

// 登出不在此清單：側邊欄底部與頁尾下拉的登出皆呼叫 useLogout()，
// 經 POST /api/logout 清除 session 後導回登入頁。
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
        title: 'EC2 部署',
        icon: 'i-lucide-server',
        link: '/ec2',
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
      {
        title: '設定',
        icon: 'i-lucide-settings',
        link: '/settings',
      },
    ],
  },
]
