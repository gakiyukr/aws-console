<script setup lang="ts">
import type { SshPublicKeyOption } from '~/lib/ssh-keys'
import { KeyRound, Loader2, Plus, Trash2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { sshKeyTypeLabel } from '~/lib/ssh-keys'

useSeoMeta({ title: '設定 - AWS 主控台' })

// 尾段自由文字（email、主機名等）作為備註顯示
function keyComment(publicKey: string) {
  const parts = publicKey.trim().split(/\s+/)
  return parts.length > 2 ? parts.slice(2).join(' ') : ''
}

// D1 datetime('now') 為 UTC 且無時區標記，補成 ISO 格式再轉本地時間
function formatCreatedAt(value: string) {
  if (!value)
    return '—'
  const date = new Date(`${value.replace(' ', 'T')}Z`)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-TW')
}

const keys = ref<SshPublicKeyOption[]>([])
const loading = ref(true)
const saving = ref(false)
const keyForm = reactive({ label: '', publicKey: '' })

async function loadData() {
  loading.value = true
  try {
    const payload = await $fetch<{ keys: SshPublicKeyOption[] }>('/api/ssh-keys')
    keys.value = payload.keys
  }
  catch (error: any) {
    toast.error(error?.data?.error || '載入公鑰清單失敗')
  }
  finally {
    loading.value = false
  }
}

async function addKey() {
  saving.value = true
  try {
    await $fetch('/api/ssh-keys', {
      method: 'POST',
      body: { label: keyForm.label, publicKey: keyForm.publicKey.trim() },
    })
    toast.success('SSH 公鑰已新增')
    Object.assign(keyForm, { label: '', publicKey: '' })
    await loadData()
  }
  catch (error: any) {
    toast.error(error?.data?.error || '新增 SSH 公鑰失敗')
  }
  finally {
    saving.value = false
  }
}

async function removeKey(key: SshPublicKeyOption) {
  // 刪除是不可逆操作，需先取得使用者明確確認。
  // eslint-disable-next-line no-alert
  if (!confirm(`確定刪除公鑰「${key.label}」？已部署的執行個體不受影響。`))
    return
  try {
    await $fetch(`/api/ssh-keys/${key.id}`, { method: 'DELETE' })
    toast.success('SSH 公鑰已刪除')
    await loadData()
  }
  catch (error: any) {
    toast.error(error?.data?.error || '刪除 SSH 公鑰失敗')
  }
}

onMounted(loadData)
</script>

<template>
  <div class="flex w-full flex-col gap-8">
    <div>
      <h2 class="text-2xl font-bold">
        設定
      </h2>
      <p class="text-sm text-muted-foreground">
        管理部署用的機器登入公鑰
      </p>
    </div>

    <section class="space-y-4">
      <div class="flex items-center gap-2">
        <KeyRound class="h-5 w-5" />
        <h3 class="text-lg font-semibold">
          機器登入公鑰
        </h3>
      </div>

      <Card>
        <CardHeader>
          <CardTitle class="text-base">
            新增公鑰
          </CardTitle>
          <CardDescription>
            金鑰儲存於 D1 並可在部署時重複選用；部署後以 root 登入且停用密碼認證。
          </CardDescription>
        </CardHeader>
        <CardContent class="grid gap-4">
          <div class="grid gap-2">
            <Label for="ssh-key-label">名稱</Label>
            <Input id="ssh-key-label" v-model="keyForm.label" placeholder="例如： MacBook Pro" />
          </div>
          <div class="grid gap-2">
            <Label for="ssh-key-value">公鑰內容</Label>
            <Textarea
              id="ssh-key-value"
              v-model="keyForm.publicKey"
              class="min-h-28 font-mono text-xs"
              placeholder="ssh-ed25519 AAAA... user@host"
            />
            <p class="text-xs text-muted-foreground">
              支援 ssh-ed25519、ssh-rsa、ECDSA 與 FIDO2 金鑰，最多 10 行。
            </p>
          </div>
        </CardContent>
        <CardFooter class="justify-end border-t pt-4">
          <Button :disabled="saving || !keyForm.label || !keyForm.publicKey" @click="addKey">
            <Loader2 v-if="saving" class="mr-2 h-4 w-4 animate-spin" /><Plus v-else class="mr-2 h-4 w-4" />新增
          </Button>
        </CardFooter>
      </Card>

      <div v-if="loading" class="flex py-8 text-sm text-muted-foreground">
        <Loader2 class="mr-2 h-4 w-4 animate-spin" />載入中...
      </div>
      <div v-else-if="!keys.length" class="border-y py-10 text-center text-sm text-muted-foreground">
        尚未新增任何公鑰
      </div>
      <div v-else class="grid gap-3 lg:grid-cols-2">
        <Card v-for="key in keys" :key="key.id">
          <CardHeader class="flex-row items-start justify-between space-y-0">
            <div class="min-w-0">
              <CardTitle class="text-base">
                {{ key.label }}
              </CardTitle>
              <CardDescription class="truncate font-mono text-xs">
                {{ key.publicKey }}
              </CardDescription>
            </div>
            <Badge variant="outline">
              {{ sshKeyTypeLabel(key.publicKey) }}
            </Badge>
          </CardHeader>
          <CardContent class="flex flex-col gap-1 text-xs text-muted-foreground">
            <span v-if="keyComment(key.publicKey)">備註：{{ keyComment(key.publicKey) }}</span>
            <span>加入時間：{{ formatCreatedAt(key.createdAt) }}</span>
          </CardContent>
          <CardFooter class="justify-end border-t pt-4">
            <Button variant="ghost" size="icon" title="刪除公鑰" @click="removeKey(key)">
              <Trash2 class="h-4 w-4" />
            </Button>
          </CardFooter>
        </Card>
      </div>
    </section>
  </div>
</template>
