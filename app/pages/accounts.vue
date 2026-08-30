<script setup lang="ts">
import { CheckCircle2, Globe, KeyRound, Loader2, Pencil, Plus, Trash2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { regionLabel } from '~/lib/regions'

useSeoMeta({ title: '帳號管理 - AWS 主控台' })

interface AwsAccount {
  id: number
  name: string
  accessKeyHint: string
  enabled: boolean
  isDefault: boolean
  lastVerifiedAt: string | null
}

// DescribeRegions(AllRegions=true) 回傳的 opt-in 狀態：
// opt-in-not-required 為預設啟用區域，opted-in 為已開通的 opt-in 區域
interface AccountRegion {
  region: string
  optInStatus: string
}

const regionStatusLabels: Record<string, string> = {
  'opt-in-not-required': '預設啟用',
  'opted-in': '已開通',
  'not-opted-in': '未開通',
}

function regionStatusLabel(status: string) {
  return regionStatusLabels[status] || '已啟用'
}

// 僅 not-opted-in 視為未啟用；空值與其餘狀態一律視為可部署，與後端過濾一致
function isRegionActive(status: string) {
  return status !== 'not-opted-in'
}

const accounts = ref<AwsAccount[]>([])
const loading = ref(true)
const saving = ref(false)
const testingId = ref<number | null>(null)
const accountDialog = ref(false)
const editingAccountId = ref<number | null>(null)
const accountForm = reactive({ name: '', accessKeyId: '', secretAccessKey: '', sessionToken: '', enabled: true, isDefault: false })

// 開通區域對話框：逐帳號列出全部 Region 與 opt-in 狀態，
// 未啟用區域可逐個送出開通請求（EC2 EnableRegion）。
const regionDialog = ref(false)
const regionAccount = ref<AwsAccount | null>(null)
const accountRegions = ref<AccountRegion[]>([])
const loadingRegions = ref(false)
const enablingRegion = ref<string | null>(null)
const activeRegions = computed(() => accountRegions.value.filter(r => isRegionActive(r.optInStatus)))
const inactiveRegions = computed(() => accountRegions.value.filter(r => !isRegionActive(r.optInStatus)))

async function loadData() {
  loading.value = true
  try {
    const accountPayload = await $fetch<{ accounts: AwsAccount[] }>('/api/accounts')
    accounts.value = accountPayload.accounts
  }
  catch (error: any) {
    toast.error(error?.data?.error || '載入帳號資料失敗')
  }
  finally {
    loading.value = false
  }
}

function openNewAccount() {
  editingAccountId.value = null
  Object.assign(accountForm, { name: '', accessKeyId: '', secretAccessKey: '', sessionToken: '', enabled: true, isDefault: accounts.value.length === 0 })
  accountDialog.value = true
}

function openEditAccount(account: AwsAccount) {
  editingAccountId.value = account.id
  Object.assign(accountForm, { name: account.name, accessKeyId: '', secretAccessKey: '', sessionToken: '', enabled: account.enabled, isDefault: account.isDefault })
  accountDialog.value = true
}

async function saveAccount() {
  saving.value = true
  try {
    const body: Record<string, unknown> = { name: accountForm.name, enabled: accountForm.enabled, isDefault: accountForm.isDefault }
    if (!editingAccountId.value || accountForm.accessKeyId || accountForm.secretAccessKey) {
      Object.assign(body, { accessKeyId: accountForm.accessKeyId, secretAccessKey: accountForm.secretAccessKey, sessionToken: accountForm.sessionToken })
    }
    await $fetch(editingAccountId.value ? `/api/accounts/${editingAccountId.value}` : '/api/accounts', {
      method: editingAccountId.value ? 'PUT' : 'POST',
      body,
    })
    toast.success(editingAccountId.value ? 'AWS 帳號已更新' : 'AWS 帳號已建立')
    accountDialog.value = false
    await loadData()
  }
  catch (error: any) {
    toast.error(error?.data?.error || '儲存 AWS 帳號失敗')
  }
  finally {
    saving.value = false
  }
}

async function testAccount(account: AwsAccount) {
  testingId.value = account.id
  try {
    await $fetch(`/api/accounts/${account.id}/test`, { method: 'POST' })
    toast.success('AWS 憑證驗證成功')
    await loadData()
  }
  catch (error: any) {
    toast.error(error?.data?.error || 'AWS 憑證驗證失敗')
  }
  finally {
    testingId.value = null
  }
}

async function removeAccount(account: AwsAccount) {
  // 刪除是不可逆操作，需先取得使用者明確確認。
  // eslint-disable-next-line no-alert
  if (!confirm(`確定刪除 AWS 帳號「${account.name}」？`))
    return
  try {
    await $fetch(`/api/accounts/${account.id}`, { method: 'DELETE' })
    toast.success('AWS 帳號已刪除')
    await loadData()
  }
  catch (error: any) {
    toast.error(error?.data?.error || '刪除 AWS 帳號失敗')
  }
}

async function openRegionDialog(account: AwsAccount) {
  regionAccount.value = account
  regionDialog.value = true
  await loadAccountRegions(account.id)
}

async function loadAccountRegions(accountId: number) {
  loadingRegions.value = true
  try {
    const payload = await $fetch<{ regions: AccountRegion[] }>(`/api/accounts/${accountId}/regions`)
    accountRegions.value = payload.regions || []
  }
  catch (error: any) {
    toast.error(error?.data?.error || '載入區域清單失敗')
  }
  finally {
    loadingRegions.value = false
  }
}

async function enableRegion(region: string) {
  if (!regionAccount.value)
    return
  enablingRegion.value = region
  try {
    const payload = await $fetch<{ message?: string }>(`/api/accounts/${regionAccount.value.id}/regions/enable`, {
      method: 'POST',
      body: { region },
    })
    toast.success(payload?.message || `已送出開通 ${region} 的請求`)
    await loadAccountRegions(regionAccount.value.id)
  }
  catch (error: any) {
    toast.error(error?.data?.error || `開通 ${region} 失敗`)
  }
  finally {
    enablingRegion.value = null
  }
}

onMounted(loadData)
</script>

<template>
  <div class="flex w-full flex-col gap-8">
    <div>
      <h2 class="text-2xl font-bold">
        帳號管理
      </h2>
      <p class="text-sm text-muted-foreground">
        管理 D1 中的 AWS 加密憑證
      </p>
    </div>

    <section class="space-y-4">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <KeyRound class="h-5 w-5" />
          <h3 class="text-lg font-semibold">
            AWS 帳號
          </h3>
        </div>
        <Button size="sm" @click="openNewAccount">
          <Plus class="mr-2 h-4 w-4" />新增 AWS 帳號
        </Button>
      </div>
      <div v-if="loading" class="flex py-8 text-sm text-muted-foreground">
        <Loader2 class="mr-2 h-4 w-4 animate-spin" />載入中...
      </div>
      <div v-else-if="!accounts.length" class="border-y py-10 text-center text-sm text-muted-foreground">
        尚未建立 AWS 帳號
      </div>
      <div v-else class="grid gap-3 lg:grid-cols-2">
        <Card v-for="account in accounts" :key="account.id">
          <CardHeader class="flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle class="text-base">
                {{ account.name }}
              </CardTitle><CardDescription>Access Key ····{{ account.accessKeyHint }}</CardDescription>
            </div>
            <div class="flex gap-1">
              <Badge v-if="account.isDefault">
                預設
              </Badge><Badge :variant="account.enabled ? 'outline' : 'secondary'">
                {{ account.enabled ? '啟用' : '停用' }}
              </Badge>
            </div>
          </CardHeader>
          <CardContent class="text-xs text-muted-foreground">
            最近驗證：{{ account.lastVerifiedAt ? new Date(account.lastVerifiedAt).toLocaleString('zh-TW') : '尚未驗證' }}
          </CardContent>
          <CardFooter class="justify-end gap-1 border-t pt-4">
            <Button variant="ghost" size="icon" title="開通區域" @click="openRegionDialog(account)">
              <Globe class="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" title="測試憑證" :disabled="testingId === account.id" @click="testAccount(account)">
              <Loader2 v-if="testingId === account.id" class="h-4 w-4 animate-spin" /><CheckCircle2 v-else class="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" title="編輯帳號" @click="openEditAccount(account)">
              <Pencil class="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" title="刪除帳號" @click="removeAccount(account)">
              <Trash2 class="h-4 w-4" />
            </Button>
          </CardFooter>
        </Card>
      </div>
    </section>

    <Dialog v-model:open="accountDialog">
      <DialogContent>
        <DialogHeader><DialogTitle>{{ editingAccountId ? '編輯 AWS 帳號' : '新增 AWS 帳號' }}</DialogTitle><DialogDescription>Secret 僅會加密寫入 D1，既有 Secret 不會讀回瀏覽器。</DialogDescription></DialogHeader>
        <div class="grid gap-4">
          <div class="grid gap-2">
            <Label for="account-name">名稱</Label><Input id="account-name" v-model="accountForm.name" />
          </div><div class="grid gap-2">
            <Label for="access-key">Access Key ID</Label><Input id="access-key" v-model="accountForm.accessKeyId" autocomplete="off" :placeholder="editingAccountId ? '留空表示不替換' : ''" />
          </div><div class="grid gap-2">
            <Label for="secret-key">Secret Access Key</Label><PasswordInput id="secret-key" v-model="accountForm.secretAccessKey" autocomplete="new-password" :placeholder="editingAccountId ? '留空表示不替換' : ''" />
          </div><div class="grid gap-2">
            <Label for="session-token">Session Token（選填）</Label><Textarea id="session-token" v-model="accountForm.sessionToken" :placeholder="editingAccountId ? '替換憑證時才需填寫' : ''" />
          </div><div class="flex gap-6">
            <label class="flex items-center gap-2 text-sm"><Checkbox :model-value="accountForm.enabled" @update:model-value="accountForm.enabled = $event === true" />啟用</label><label class="flex items-center gap-2 text-sm"><Checkbox :model-value="accountForm.isDefault" @update:model-value="accountForm.isDefault = $event === true" />設為預設</label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="accountDialog = false">
            取消
          </Button><Button :disabled="saving || !accountForm.name || (!editingAccountId && (!accountForm.accessKeyId || !accountForm.secretAccessKey))" @click="saveAccount">
            <Loader2 v-if="saving" class="mr-2 h-4 w-4 animate-spin" />儲存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="regionDialog">
      <DialogContent class="max-w-lg">
        <DialogHeader>
          <DialogTitle>開通新區域 — {{ regionAccount?.name }}</DialogTitle>
          <DialogDescription>
            列出此 AWS 帳號的全部 Region；開通 opt-in 區域後需數分鐘才可供部署。
          </DialogDescription>
        </DialogHeader>
        <div v-if="loadingRegions" class="flex py-8 text-sm text-muted-foreground">
          <Loader2 class="mr-2 h-4 w-4 animate-spin" />載入中...
        </div>
        <div v-else class="max-h-80 space-y-5 overflow-y-auto pr-1">
          <div class="space-y-2">
            <p class="text-sm font-medium">
              可部署（{{ activeRegions.length }}）
            </p>
            <div v-for="r in activeRegions" :key="r.region" class="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
              <span class="text-sm">{{ regionLabel(r.region) }}</span>
              <Badge variant="outline">
                {{ regionStatusLabel(r.optInStatus) }}
              </Badge>
            </div>
            <p v-if="!activeRegions.length" class="text-xs text-muted-foreground">
              沒有已啟用的區域
            </p>
          </div>
          <div class="space-y-2">
            <p class="text-sm font-medium">
              未啟用（{{ inactiveRegions.length }}）
            </p>
            <div v-for="r in inactiveRegions" :key="r.region" class="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
              <span class="text-sm">{{ regionLabel(r.region) }}</span>
              <Button size="sm" variant="outline" :disabled="enablingRegion !== null" @click="enableRegion(r.region)">
                <Loader2 v-if="enablingRegion === r.region" class="mr-2 h-4 w-4 animate-spin" />開通
              </Button>
            </div>
            <p v-if="!inactiveRegions.length" class="text-xs text-muted-foreground">
              所有區域皆已啟用
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="regionDialog = false">
            關閉
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
