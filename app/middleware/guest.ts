// 已登入使用者造訪登入頁時導向主控台，避免重複進入認證流程。
export default defineNuxtRouteMiddleware(async () => {
  const session = await $fetch<{ authenticated: boolean }>('/api/session')
    .catch(() => ({ authenticated: false }))

  if (session.authenticated)
    return navigateTo('/')
})
