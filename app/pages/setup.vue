<script setup lang="ts">
import { Loader2, PlugZap, ShieldCheck } from 'lucide-vue-next'
import { toast } from 'vue-sonner'

useSeoMeta({ title: '初始設定 — AWS 主控台' })

// OOBE 初始設定：填入 IdP 資訊與綁定 email → 測試連線 → 走一次真實
// SSO 驗證（回頭 email 必須與綁定 email 一致）→ 設定存入 D1 後直接
// 進入主控台。設定完成後本頁會被導回 /login，重新設定需清除 D1 的
// sso_config（見 README）。

definePageMeta({
  layout: 'blank',
})

interface SetupForm {
  email: string
  issuer: string
  authorizationUrl: string
  tokenUrl: string
  jwksUrl: string
  clientId: string
  clientSecret: string
}

const form = reactive<SetupForm>({
  email: '',
  issuer: '',
  authorizationUrl: '',
  tokenUrl: '',
  jwksUrl: '',
  clientId: '',
  clientSecret: '',
})

const testing = ref(false)
const testResult = ref<{ ok: boolean, message: string } | null>(null)
const starting = ref(false)
const showAdvanced = ref(false)
const route = useRoute()

const CALLBACK_ERRORS: Record<string, string> = {
  email_mismatch: 'SSO 回傳的 email 與綁定 email 不符，請確認登入的 IdP 帳號後再試。',
  save_failed: 'SSO 驗證成功，但設定儲存失敗，請重試。',
  state_mismatch: '設定流程已逾時，請重新填寫並驗證。',
  idp_error: 'IdP 端中止了驗證流程，請再試一次。',
  verification_failed: 'SSO 驗證失敗，請檢查設定後再試。',
  configuration: '設定內容無效，請檢查後再試。',
}

const callbackError = computed(() => {
  const code = typeof route.query.error === 'string' ? route.query.error : ''
  return code ? (CALLBACK_ERRORS[code] || '設定失敗，請再試一次。') : ''
})

const canSubmit = computed(() =>
  form.email && form.clientId && form.clientSecret && (form.issuer || (form.authorizationUrl && form.tokenUrl && form.jwksUrl)),
)

// 「開始 SSO 驗證」需先通過測試連線；表單任何欄位變更後即失效，須重測
const testedOk = ref(false)

watch(form, () => {
  testedOk.value = false
  testResult.value = null
})

async function testConnection() {
  if (testing.value)
    return
  testing.value = true
  testResult.value = null
  try {
    const result = await $fetch<{ ok: boolean, error?: string, issuer?: string }>('/api/setup/test', {
      method: 'POST',
      body: { ...form },
    })
    testResult.value = result.ok
      ? { ok: true, message: `連線成功，IdP：${result.issuer}` }
      : { ok: false, message: result.error || '連線失敗' }
    testedOk.value = result.ok
  }
  catch (error: any) {
    testResult.value = { ok: false, message: error?.data?.error || '連線失敗' }
    testedOk.value = false
  }
  finally {
    testing.value = false
  }
}

async function startVerification() {
  if (starting.value || !testedOk.value)
    return
  starting.value = true
  try {
    const { redirectUrl } = await $fetch<{ redirectUrl: string }>('/api/setup/start', {
      method: 'POST',
      body: { ...form },
    })
    await navigateTo(redirectUrl, { external: true })
  }
  catch (error: any) {
    toast.error(error?.data?.error || '無法啟動 SSO 驗證')
    starting.value = false
  }
}
</script>

<template>
  <div class="grid gap-6 mx-auto w-full max-w-lg">
    <div class="grid gap-2 text-center">
      <h1 class="text-2xl font-semibold tracking-tight">
        歡迎使用 AWS 主控台
      </h1>
      <p class="text-balance text-sm text-muted-foreground">
        首次執行初始設定：綁定你的 SSO 帳號，完成後即可進入主控台
      </p>
    </div>

    <Card>
      <CardContent class="pt-6">
        <div class="grid gap-4">
          <div class="grid gap-2">
            <Label for="setup-email">綁定 email</Label>
            <Input
              id="setup-email"
              v-model="form.email"
              type="email"
              placeholder="you@example.com"
              autocomplete="email"
              :disabled="starting"
            />
            <p class="text-xs text-muted-foreground">
              完成驗證後，僅此 email 能登入主控台；需與 IdP 回傳的 email 一致。
            </p>
          </div>

          <div class="grid gap-2">
            <Label for="setup-issuer">IdP Issuer URL</Label>
            <Input
              id="setup-issuer"
              v-model="form.issuer"
              placeholder="https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<AUD>"
              autocomplete="off"
              :disabled="starting"
            />
            <p class="text-xs text-muted-foreground">
              IdP 頁面顯示的 Issuer / Discovery URL。Cloudflare Access 的最後一段是
              <span class="font-mono">AUD</span>，不是 Client ID。
            </p>
            <button
              type="button"
              class="text-xs text-muted-foreground underline-offset-4 hover:underline"
              @click="showAdvanced = !showAdvanced"
            >
              {{ showAdvanced ? '收起明確端點設定' : 'discovery 無效？改填 IdP 提供的三個明確端點' }}
            </button>
          </div>

          <div v-if="showAdvanced" class="grid gap-2 rounded-md border p-3">
            <p class="text-xs text-muted-foreground">
              Cloudflare Access 的 SaaS 應用程式頁面會直接列出這三個端點；填齊後跳過 discovery（Issuer 仍須填寫）。
            </p>
            <div class="grid gap-2">
              <Label for="setup-authz">授權端點</Label>
              <Input id="setup-authz" v-model="form.authorizationUrl" placeholder="https://.../authorization" autocomplete="off" :disabled="starting" />
            </div>
            <div class="grid gap-2">
              <Label for="setup-token">Token 端點</Label>
              <Input id="setup-token" v-model="form.tokenUrl" placeholder="https://.../token" autocomplete="off" :disabled="starting" />
            </div>
            <div class="grid gap-2">
              <Label for="setup-jwks">JWKS URL</Label>
              <Input id="setup-jwks" v-model="form.jwksUrl" placeholder="https://.../jwks" autocomplete="off" :disabled="starting" />
            </div>
          </div>

          <div class="grid gap-2">
            <Label for="setup-client-id">Client ID</Label>
            <Input id="setup-client-id" v-model="form.clientId" autocomplete="off" :disabled="starting" />
          </div>
          <div class="grid gap-2">
            <Label for="setup-client-secret">Client Secret</Label>
            <PasswordInput
              id="setup-client-secret"
              v-model="form.clientSecret"
              placeholder="IdP 提供的 Client Secret"
              autocomplete="new-password"
              :disabled="starting"
            />
          </div>

          <p v-if="callbackError" class="text-sm text-destructive">
            {{ callbackError }}
          </p>
          <p
            v-if="testResult"
            class="text-sm"
            :class="testResult.ok ? 'text-emerald-600' : 'text-destructive'"
          >
            {{ testResult.message }}
          </p>

          <div class="grid gap-2">
            <Button variant="outline" :disabled="testing || starting || !canSubmit" @click="testConnection">
              <Loader2 v-if="testing" class="mr-2 h-4 w-4 animate-spin" />
              <PlugZap v-else class="mr-2 h-4 w-4" />
              測試連線
            </Button>
            <Button
              :disabled="testing || starting || !testedOk"
              :title="testedOk ? undefined : '請先通過測試連線'"
              @click="startVerification"
            >
              <Loader2 v-if="starting" class="mr-2 h-4 w-4 animate-spin" />
              <ShieldCheck v-else class="mr-2 h-4 w-4" />
              開始 SSO 驗證
            </Button>
            <p class="text-xs text-muted-foreground">
              需先通過測試連線；將導向 IdP 完成一次登入，回頭的 email 與綁定 email 一致時設定才會生效。
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
