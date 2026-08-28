<script setup lang="ts">
import { CheckCircle2, KeyRound, Loader2, Pencil, Plus, Trash2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'

useSeoMeta({ title: '帳號管理 - AWS 主控台' })

interface AwsAccount {
  id: number
  name: string
  accessKeyHint: string
  enabled: boolean
  isDefault: boolean
  lastVerifiedAt: string | null
}

const accounts = ref<AwsAccount[]>([])
const loading = ref(true)
const saving = ref(false)
const testingId = ref<number | null>(null)
const accountDialog = ref(false)
const editingAccountId = ref<number | null>(null)
const accountForm = reactive({ name: '', accessKeyId: '', secretAccessKey: '', sessionToken: '', enabled: true, isDefault: false })

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
  </div>
</template>
