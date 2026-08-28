<script setup lang="ts">
import { Loader2, Plus, RefreshCw } from 'lucide-vue-next'
import { toast } from 'vue-sonner'

useSeoMeta({
  title: '機器總覽 — AWS 主控台',
})

// 機器列資料結構：D1 清單 × DescribeInstances 即時狀態合併後的結果
interface MachineRow {
  id: number
  region: string
  instanceId: string
  name: string
  isWavelength: boolean
  state: string | null
  publicIpAddress: string | null
  publicDnsName: string | null
  awsAccountId: number | null
  awsAccountName: string | null
}

interface AwsAccountOption { id: number, name: string, enabled: boolean, isDefault: boolean }

const machines = ref<MachineRow[]>([])
const loading = ref(true)
const refreshing = ref(false)
const actionPendingId = ref<number | null>(null)
const accounts = ref<AwsAccountOption[]>([])

// 統計卡片資料
const stats = computed(() => {
  const running = machines.value.filter(m => m.state === 'running').length
  const stopped = machines.value.filter(m => m.state === 'stopped').length
  const wavelength = machines.value.filter(m => m.isWavelength).length
  const regions = new Set(machines.value.map(m => m.region)).size
  return { running, stopped, wavelength, regions }
})

async function loadMachines() {
  loading.value = true
  try {
    machines.value = await $fetch<MachineRow[]>('/api/machines')
  }
  catch {
    toast.error('載入機器清單失敗')
  }
  finally {
    loading.value = false
  }
}

async function refresh() {
  refreshing.value = true
  try {
    machines.value = await $fetch<MachineRow[]>('/api/machines')
  }
  catch {
    toast.error('重新整理失敗')
  }
  finally {
    refreshing.value = false
  }
}

// 電源操作：先經確認對話框才會呼叫
async function performAction(machine: MachineRow, action: 'start' | 'stop') {
  actionPendingId.value = machine.id
  try {
    await $fetch(`/api/machines/${machine.id}/action`, {
      method: 'POST',
      body: JSON.stringify({ action }),
      headers: { 'Content-Type': 'application/json' },
    })
    toast.success(`${machine.name} 已送出${action === 'start' ? '啟動' : '關閉'}請求`)
    await new Promise(resolve => setTimeout(resolve, 2000))
    await loadMachines()
  }
  catch (error: any) {
    toast.error(error?.data?.error || '操作失敗')
  }
  finally {
    actionPendingId.value = null
  }
}

const stopTarget = ref<MachineRow | null>(null)

function requestPowerAction(machine: MachineRow, action: 'start' | 'stop') {
  if (action === 'stop') {
    stopTarget.value = machine
    return
  }
  return performAction(machine, action)
}

async function confirmStop() {
  const machine = stopTarget.value
  stopTarget.value = null
  if (machine)
    await performAction(machine, 'stop')
}

// 新增機器對話框
const showAddDialog = ref(false)
const addForm = ref<{ awsAccountId: number | null, region: string, instanceId: string, name: string, isWavelength: boolean }>({ awsAccountId: null, region: '', instanceId: '', name: '', isWavelength: false })
const adding = ref(false)

async function submitAdd() {
  if (adding.value)
    return
  adding.value = true
  try {
    await $fetch('/api/machines', {
      method: 'POST',
      body: JSON.stringify(addForm.value),
      headers: { 'Content-Type': 'application/json' },
    })
    toast.success('機器已新增')
    showAddDialog.value = false
    addForm.value = { awsAccountId: accounts.value.find(account => account.isDefault)?.id || null, region: '', instanceId: '', name: '', isWavelength: false }
    await loadMachines()
  }
  catch (error: any) {
    toast.error(error?.data?.error || '新增失敗')
  }
  finally {
    adding.value = false
  }
}

// 移除機器
const removeTarget = ref<MachineRow | null>(null)
const removing = ref(false)

async function submitRemove() {
  if (!removeTarget.value || removing.value)
    return
  removing.value = true
  try {
    await $fetch(`/api/machines/${removeTarget.value.id}`, { method: 'DELETE' })
    toast.success('機器已從清單移除')
    removeTarget.value = null
    await loadMachines()
  }
  catch (error: any) {
    toast.error(error?.data?.error || '移除失敗')
  }
  finally {
    removing.value = false
  }
}

// 狀態徽章樣式
function stateBadgeVariant(state: string | null) {
  if (state === 'running')
    return 'default'
  if (state === 'stopped' || state === 'stopping')
    return 'secondary'
  return 'outline'
}

function stateLabel(state: string | null) {
  if (!state)
    return '未知'
  const labels: Record<string, string> = {
    'running': '運行中',
    'stopped': '已停止',
    'pending': '啟動中',
    'stopping': '停止中',
    'shutting-down': '關閉中',
    'terminated': '已終止',
  }
  return labels[state] || state
}

async function copyText(text: string) {
  await navigator.clipboard.writeText(text)
  toast.success('已複製到剪貼簿')
}

onMounted(async () => {
  try {
    const payload = await $fetch<{ accounts: AwsAccountOption[] }>('/api/accounts')
    accounts.value = payload.accounts.filter(account => account.enabled)
    addForm.value.awsAccountId = accounts.value.find(account => account.isDefault)?.id || accounts.value[0]?.id || null
  }
  catch {
    toast.error('載入 AWS 帳號失敗')
  }
  await loadMachines()
})
</script>

<template>
  <div class="w-full flex flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 class="text-2xl font-bold tracking-tight">
          機器總覽
        </h2>
        <p class="text-sm text-muted-foreground">
          管理 D1 清單中所有 EC2 執行個體的電源狀態
        </p>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" :disabled="refreshing" @click="refresh">
          <Loader2 v-if="refreshing" class="mr-1 h-4 w-4 animate-spin" />
          <RefreshCw v-else class="mr-1 h-4 w-4" />
          重新整理
        </Button>
        <Button size="sm" @click="showAddDialog = true">
          <Plus class="mr-1 h-4 w-4" />
          新增機器
        </Button>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-4 *:data-[slot=card]:shadow-xs @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
      <Card>
        <CardHeader>
          <CardDescription>運行中</CardDescription>
          <CardTitle class="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {{ stats.running }}
          </CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>已停止</CardDescription>
          <CardTitle class="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {{ stats.stopped }}
          </CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>Wavelength 執行個體</CardDescription>
          <CardTitle class="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {{ stats.wavelength }}
          </CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>涵蓋地區</CardDescription>
          <CardTitle class="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {{ stats.regions }}
          </CardTitle>
        </CardHeader>
      </Card>
    </div>

    <Card>
      <CardContent class="pt-6">
        <div v-if="loading" class="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 class="mr-2 h-5 w-5 animate-spin" />
          載入中…
        </div>
        <div v-else-if="machines.length === 0" class="flex flex-col items-center gap-3 py-12 text-muted-foreground">
          <p>清單中還沒有機器。</p>
          <Button variant="outline" size="sm" @click="showAddDialog = true">
            <Plus class="mr-1 h-4 w-4" />
            新增第一台機器
          </Button>
        </div>
        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>名稱</TableHead>
              <TableHead>地區</TableHead>
              <TableHead>AWS 帳號</TableHead>
              <TableHead>狀態</TableHead>
              <TableHead>公網 IP</TableHead>
              <TableHead>DNS</TableHead>
              <TableHead class="text-right">
                操作
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="machine in machines" :key="machine.id">
              <TableCell>
                <div class="flex items-center gap-2">
                  <span class="font-medium">{{ machine.name }}</span>
                  <Badge v-if="machine.isWavelength" variant="outline" class="text-[10px]">
                    WL
                  </Badge>
                </div>
                <div class="font-mono text-xs text-muted-foreground">
                  {{ machine.instanceId }}
                </div>
              </TableCell>
              <TableCell class="font-mono text-xs">
                {{ machine.region }}
              </TableCell>
              <TableCell class="text-xs">
                {{ machine.awsAccountName || '未關聯' }}
              </TableCell>
              <TableCell>
                <Badge :variant="stateBadgeVariant(machine.state)">
                  {{ stateLabel(machine.state) }}
                </Badge>
              </TableCell>
              <TableCell>
                <button
                  v-if="machine.publicIpAddress"
                  class="inline-flex items-center gap-1 font-mono text-xs underline-offset-4 hover:underline"
                  title="點擊複製"
                  @click="copyText(machine.publicIpAddress!)"
                >
                  {{ machine.publicIpAddress }}
                </button>
                <span v-else class="text-muted-foreground">—</span>
              </TableCell>
              <TableCell>
                <button
                  v-if="machine.publicDnsName"
                  class="max-w-56 truncate font-mono text-xs underline-offset-4 hover:underline"
                  title="點擊複製"
                  @click="copyText(machine.publicDnsName!)"
                >
                  {{ machine.publicDnsName }}
                </button>
                <span v-else class="text-muted-foreground">—</span>
              </TableCell>
              <TableCell class="text-right">
                <div class="flex items-center justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    title="重新整理狀態"
                    :disabled="refreshing || actionPendingId !== null"
                    @click="refresh"
                  >
                    <RefreshCw class="h-4 w-4" />
                  </Button>
                  <Button
                    v-if="machine.state !== 'running'"
                    variant="outline"
                    size="sm"
                    :disabled="actionPendingId === machine.id"
                    @click="requestPowerAction(machine, 'start')"
                  >
                    啟動
                  </Button>
                  <Button
                    v-if="machine.state === 'running'"
                    variant="outline"
                    size="sm"
                    :disabled="actionPendingId === machine.id"
                    @click="requestPowerAction(machine, 'stop')"
                  >
                    關閉
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    class="text-destructive hover:text-destructive"
                    :disabled="actionPendingId === machine.id"
                    @click="removeTarget = machine"
                  >
                    移除
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <Dialog v-model:open="showAddDialog">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新增機器</DialogTitle>
          <DialogDescription>
            將既有 EC2 執行個體加入管理清單（儲存於 D1）
          </DialogDescription>
        </DialogHeader>
        <div class="grid gap-4 py-2">
          <div class="grid gap-2">
            <Label for="add-account">AWS 帳號</Label>
            <select id="add-account" v-model.number="addForm.awsAccountId" class="h-9 rounded-md border bg-background px-3 text-sm">
              <option :value="null" disabled>
                請選擇 AWS 帳號
              </option>
              <option v-for="account in accounts" :key="account.id" :value="account.id">
                {{ account.name }}{{ account.isDefault ? '（預設）' : '' }}
              </option>
            </select>
          </div>
          <div class="grid gap-2">
            <Label for="add-region">地區</Label>
            <Input
              id="add-region"
              v-model="addForm.region"
              placeholder="us-east-1"
            />
          </div>
          <div class="grid gap-2">
            <Label for="add-instance-id">執行個體 ID</Label>
            <Input
              id="add-instance-id"
              v-model="addForm.instanceId"
              placeholder="i-0abc123def4567890"
            />
          </div>
          <div class="grid gap-2">
            <Label for="add-name">顯示名稱</Label>
            <Input
              id="add-name"
              v-model="addForm.name"
              placeholder="SEA-1"
            />
          </div>
          <div class="flex items-center gap-2">
            <Checkbox
              id="add-wavelength"
              :model-value="addForm.isWavelength"
              @update:model-value="addForm.isWavelength = $event === true"
            />
            <Label for="add-wavelength">Wavelength 執行個體</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="adding" @click="showAddDialog = false">
            取消
          </Button>
          <Button :disabled="adding || !addForm.awsAccountId || !addForm.region || !addForm.instanceId || !addForm.name" @click="submitAdd">
            <Loader2 v-if="adding" class="mr-2 h-4 w-4 animate-spin" />
            新增
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog :open="stopTarget !== null" @update:open="stopTarget = $event ? stopTarget : null">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>確認關閉機器</AlertDialogTitle>
          <AlertDialogDescription>
            確定要關閉「{{ stopTarget?.name }}」嗎？此操作將停止 AWS 上的 EC2 執行個體。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel @click="stopTarget = null">
            取消
          </AlertDialogCancel>
          <AlertDialogAction @click="confirmStop">
            關閉
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog :open="removeTarget !== null" @update:open="removeTarget = $event ? removeTarget : null">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>確認移除機器</AlertDialogTitle>
          <AlertDialogDescription>
            將「{{ removeTarget?.name }}」從管理清單移除？這只會移除清單記錄，不會終止 AWS 上的執行個體。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="removing" @click="removeTarget = null">
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            class="bg-destructive text-white hover:bg-destructive/90"
            :disabled="removing"
            @click="submitRemove"
          >
            <Loader2 v-if="removing" class="mr-2 h-4 w-4 animate-spin" />
            移除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
