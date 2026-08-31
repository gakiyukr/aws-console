// 全域路由守衛（僅客戶端）：SSR 的頁面重導由 server/middleware/auth.ts
// 以 302 完成——Workers 免費方案 CPU 限制緊，SSR 內再打 /api/session
// 子請求會超出限制，故本中介層在伺服器端直接跳過。
// 客戶端 SPA 導航不會經過伺服器中介層，此處補上 session 檢查，
// 避免已登出的分頁在站內導航時停在只剩外殼的受保護頁面。
const PUBLIC_PATHS = new Set(['/login', '/setup', '/401', '/403', '/404', '/500', '/503'])

interface SessionState {
  authenticated: boolean
  configurationState: 'configured' | 'unconfigured'
}

export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server) {
    return
  }

  let session: SessionState
  try {
    session = await $fetch<SessionState>('/api/session')
  }
  catch (error: any) {
    const status = Number(error?.statusCode || error?.status || error?.response?.status)
    if (status === 503) {
      const reason = typeof error?.data?.reason === 'string' ? error.data.reason : 'authentication_unavailable'
      if (to.path !== '/503')
        return navigateTo({ path: '/503', query: { reason } })
      return
    }
    session = { authenticated: false, configurationState: 'configured' }
  }

  if (session.configurationState === 'unconfigured') {
    if (to.path !== '/setup')
      return navigateTo('/setup')
    return
  }

  if (!session.authenticated && !PUBLIC_PATHS.has(to.path)) {
    return navigateTo('/login')
  }
  if (session.authenticated && to.path === '/login') {
    return navigateTo('/')
  }
})
