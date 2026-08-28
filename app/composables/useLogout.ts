// 登出流程：呼叫後端清除 session 與 CSRF cookie，成功與否皆導回登入頁，
// 避免卡在無效 session 的畫面。側邊欄底部按鈕與頁尾下拉選單共用。
export function useLogout() {
  async function logout() {
    try {
      await $fetch('/api/logout', { method: 'POST' })
    }
    catch {
      // 即使請求失敗仍導向登入頁，避免卡在無效 session 的畫面
    }
    await navigateTo('/login')
  }

  return { logout }
}
