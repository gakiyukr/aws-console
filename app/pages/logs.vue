<script setup lang="ts">
import { Download, Loader2, RefreshCw } from 'lucide-vue-next'
import { toast } from 'vue-sonner'

useSeoMeta({ title: '操作日誌 - AWS 主控台' })

interface OperationLog {
  id: number
  createdAt: string
  action: string
  region: string | null
  instanceId: string | null
  status: 'success' | 'failure'
  detail: string | null
  awsAccountId: number | null
}

interface AwsAccountOption { id: number, name: string }

const logs = ref<OperationLog[]>([])
const accounts = ref<AwsAccountOption[]>([])
const loading = ref(true)
const filters = reactive({ accountId: '', action: '', status: '', limit: 200 })
const accountNames = computed(() => Object.fromEntries(accounts.value.map(account => [account.id, account.name])))

const actionLabels: Record<string, string> = {
  start: '啟動執行個體',
  stop: '停止執行個體',
  init_zone: '初始化 WL Zone',
  deploy_wavelength: '部署 Wavelength EC2',
  deploy_regional: '部署一般 EC2',
  deploy_forwarder: '部署 SSH forwarder',
}

function errorMessage(error: any) {
  return error?.data?.error || error?.message || '載入操作日誌失敗'
}

function displayDetail(detail: string | null) {
  if (!detail)
    return '—'
  try {
    return JSON.stringify(JSON.parse(detail), null, 2)
  }
  catch {
    return detail
  }
}

async function loadLogs() {
  loading.value = true
  try {
    const query: Record<string, string | number> = { limit: filters.limit }
    if (filters.action)
      query.action = filters.action
    if (filters.status)
      query.status = filters.status
    if (filters.accountId)
      query.account_id = filters.accountId
    const payload = await $fetch<{ logs: OperationLog[] }>('/api/logs', { query })
    logs.value = payload.logs || []
  }
  catch (error) {
    toast.error(errorMessage(error))
  }
  finally {
    loading.value = false
  }
}

function downloadLogs() {
  const blob = new Blob([JSON.stringify(logs.value, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `aws-console-operation-logs-${new Date().toISOString().replaceAll(':', '-')}.json`
  link.click()
  URL.revokeObjectURL(url)
}

onMounted(async () => {
  try {
    accounts.value = (await $fetch<{ accounts: AwsAccountOption[] }>('/api/accounts')).accounts
  }
  catch {
    toast.error('載入 AWS 帳號失敗')
  }
  await loadLogs()
})
</script>

<template>
  <div class="flex w-full flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 class="text-2xl font-bold">
          操作日誌
        </h2>
        <p class="text-sm text-muted-foreground">
          查看電源操作、Wavelength 初始化與部署稽核記錄
        </p>
      </div>
      <div class="flex gap-2">
        <Button variant="outline" size="sm" :disabled="loading || !logs.length" @click="downloadLogs">
          <Download class="mr-2 h-4 w-4" />
          下載 JSON
        </Button>
        <Button size="sm" :disabled="loading" @click="loadLogs">
          <Loader2 v-if="loading" class="mr-2 h-4 w-4 animate-spin" />
          <RefreshCw v-else class="mr-2 h-4 w-4" />
          重新整理
        </Button>
      </div>
    </div>

    <Card>
      <CardContent class="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_140px_auto] lg:items-end">
        <div class="grid gap-2">
          <Label for="log-account">AWS 帳號</Label>
          <select id="log-account" v-model="filters.accountId" class="h-9 rounded-md border bg-background px-3 text-sm">
            <option value="">
              全部帳號
            </option>
            <option v-for="account in accounts" :key="account.id" :value="String(account.id)">
              {{ account.name }}
            </option>
          </select>
        </div>
        <div class="grid gap-2">
          <Label for="log-action">操作</Label>
          <select id="log-action" v-model="filters.action" class="h-9 rounded-md border bg-background px-3 text-sm">
            <option value="">
              全部操作
            </option>
            <option v-for="(label, action) in actionLabels" :key="action" :value="action">
              {{ label }}
            </option>
          </select>
        </div>
        <div class="grid gap-2">
          <Label for="log-status">結果</Label>
          <select id="log-status" v-model="filters.status" class="h-9 rounded-md border bg-background px-3 text-sm">
            <option value="">
              全部結果
            </option>
            <option value="success">
              成功
            </option>
            <option value="failure">
              失敗
            </option>
          </select>
        </div>
        <div class="grid gap-2">
          <Label for="log-limit">筆數</Label>
          <select id="log-limit" v-model.number="filters.limit" class="h-9 rounded-md border bg-background px-3 text-sm">
            <option :value="50">
              50
            </option>
            <option :value="200">
              200
            </option>
            <option :value="500">
              500
            </option>
            <option :value="1000">
              1000
            </option>
          </select>
        </div>
        <Button variant="outline" :disabled="loading" @click="loadLogs">
          套用篩選
        </Button>
      </CardContent>
    </Card>

    <Card>
      <CardContent class="pt-6">
        <div v-if="loading" class="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 class="mr-2 h-5 w-5 animate-spin" />
          載入中...
        </div>
        <div v-else-if="!logs.length" class="py-12 text-center text-sm text-muted-foreground">
          沒有符合條件的操作日誌
        </div>
        <div v-else class="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>時間</TableHead>
                <TableHead>操作</TableHead>
                <TableHead>AWS 帳號</TableHead>
                <TableHead>地區／執行個體</TableHead>
                <TableHead>結果</TableHead>
                <TableHead class="min-w-80">
                  詳細資料
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="entry in logs" :key="entry.id">
                <TableCell class="whitespace-nowrap text-xs">
                  {{ new Date(entry.createdAt).toLocaleString('zh-TW') }}
                </TableCell>
                <TableCell class="text-xs">
                  {{ entry.awsAccountId ? accountNames[entry.awsAccountId] || `#${entry.awsAccountId}` : '—' }}
                </TableCell>
                <TableCell>
                  <div class="font-medium">
                    {{ actionLabels[entry.action] || entry.action }}
                  </div>
                  <div class="font-mono text-xs text-muted-foreground">
                    {{ entry.action }}
                  </div>
                </TableCell>
                <TableCell>
                  <div class="font-mono text-xs">
                    {{ entry.region || '—' }}
                  </div>
                  <div class="font-mono text-xs text-muted-foreground">
                    {{ entry.instanceId || '—' }}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge :variant="entry.status === 'success' ? 'default' : 'destructive'">
                    {{ entry.status === 'success' ? '成功' : '失敗' }}
                  </Badge>
                </TableCell>
                <TableCell>
                  <pre class="max-h-48 max-w-2xl overflow-auto whitespace-pre-wrap break-all text-xs">{{ displayDetail(entry.detail) }}</pre>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
