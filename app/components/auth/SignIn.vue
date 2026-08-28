<script setup lang="ts">
import { Loader2, LogIn } from 'lucide-vue-next'

// SSO 登入：點擊後導向 /api/auth/login（302 至 IdP 授權端點）。
// callback 完成後帶 session 回到主控台；失敗則回到本頁並帶 error 代碼。
const isRedirecting = ref(false)
const route = useRoute()

const ERROR_MESSAGES: Record<string, string> = {
  configuration: '伺服器尚未完成 SSO 設定，請聯絡管理者。',
  idp_error: '登入流程被 IdP 中止，請再試一次。',
  state_mismatch: '登入流程已逾時或狀態不符，請重新登入。',
  email_not_allowed: '此帳號未獲授權使用本主控台。',
  verification_failed: '登入驗證失敗，請再試一次。',
}

const errorMessage = computed(() => {
  const code = typeof route.query.error === 'string' ? route.query.error : ''
  return code ? (ERROR_MESSAGES[code] || '登入失敗，請再試一次。') : ''
})

function startLogin() {
  if (isRedirecting.value)
    return
  isRedirecting.value = true
  navigateTo('/api/auth/login', { external: true })
}
</script>

<template>
  <div class="grid gap-6">
    <div class="grid gap-2 text-center">
      <h1 class="text-2xl font-semibold tracking-tight">
        AWS 主控台
      </h1>
      <p class="text-balance text-sm text-muted-foreground">
        透過 SSO 驗證身分以繼續
      </p>
    </div>
    <p v-if="errorMessage" class="text-sm text-destructive">
      {{ errorMessage }}
    </p>
    <Button class="w-full" :disabled="isRedirecting" @click="startLogin">
      <Loader2 v-if="isRedirecting" class="mr-2 h-4 w-4 animate-spin" />
      <LogIn v-else class="mr-2 h-4 w-4" />
      使用 SSO 登入
    </Button>
  </div>
</template>
