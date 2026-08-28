<script setup lang="ts">
import { Loader2 } from 'lucide-vue-next'
import PasswordInput from '~/components/PasswordInput.vue'

const password = ref('')
const username = ref('admin')
const isLoading = ref(false)
const errorMessage = ref('')

// 送出前先取得 CSRF token（ec2_csrf cookie），再連同密碼送至 /api/login
async function onSubmit(event: Event) {
  event.preventDefault()
  if (!username.value || !password.value || isLoading.value)
    return

  isLoading.value = true
  errorMessage.value = ''

  try {
    const { csrfToken } = await $fetch<{ csrfToken: string }>('/api/csrf', { method: 'GET' })
    await $fetch('/api/login', {
      method: 'POST',
      body: { username: username.value, password: password.value },
      headers: { 'x-csrf-token': csrfToken },
    })
    await navigateTo('/')
  }
  catch (error: any) {
    const status = error?.statusCode || error?.response?.status
    if (status === 429)
      errorMessage.value = '嘗試次數過多，請稍後再試。'
    else if (status === 403)
      errorMessage.value = '安全驗證失敗，請重新整理頁面後再試。'
    else
      errorMessage.value = '帳號或密碼錯誤，請再試一次。'
  }
  finally {
    isLoading.value = false
  }
}
</script>

<template>
  <form class="grid gap-6" @submit="onSubmit">
    <div class="grid gap-2 text-center">
      <h1 class="text-2xl font-semibold tracking-tight">
        AWS 主控台
      </h1>
      <p class="text-balance text-sm text-muted-foreground">
        請輸入管理密碼以繼續
      </p>
    </div>
    <div class="grid gap-2">
      <Label for="username">
        使用者名稱
      </Label>
      <Input
        id="username"
        v-model="username"
        :disabled="isLoading"
        autocomplete="username"
      />
    </div>
    <div class="grid gap-2">
      <Label for="password">
        管理密碼
      </Label>
      <PasswordInput
        id="password"
        v-model="password"
        :disabled="isLoading"
        auto-complete="current-password"
      />
    </div>
    <p v-if="errorMessage" class="text-sm text-destructive">
      {{ errorMessage }}
    </p>
    <Button type="submit" class="w-full" :disabled="isLoading || !username || !password">
      <Loader2 v-if="isLoading" class="mr-2 h-4 w-4 animate-spin" />
      登入
    </Button>
  </form>
</template>
