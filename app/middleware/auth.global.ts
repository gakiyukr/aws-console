// 全域路由守衛（僅客戶端）：SSR 的頁面重導由 server/middleware/auth.ts
// 以 302 完成——Workers 免費方案 CPU 限制緊，SSR 內再打 /api/session
// 子請求會超出限制，故本中介層在伺服器端直接跳過。
// 客戶端 SPA 導航不會經過伺服器中介層，此處補上 session 檢查，
// 避免已登出的分頁在站內導航時停在只剩外殼的受保護頁面。
const PUBLIC_PATHS = new Set(['/login', '/401', '/403', '/404', '/500', '/503'])

export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server) {
    return
  }

  const session = await $fetch<{ authenticated: boolean }>('/api/session')
    .catch(() => ({ authenticated: false }))

  if (!session.authenticated && !PUBLIC_PATHS.has(to.path)) {
    return navigateTo('/login')
  }
  if (session.authenticated && to.path === '/login') {
    return navigateTo('/')
  }
})
