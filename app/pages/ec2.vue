<script setup lang="ts">
import { Check, Clipboard, Download, Loader2, RefreshCw, Server, Trash2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'

useSeoMeta({ title: 'EC2 部署 - AWS 主控台' })

interface SelectOption {
  value: string
  label: string
}

interface AwsAccountOption {
  id: number
  name: string
  enabled: boolean
  isDefault: boolean
}

interface ProgressEntry {
  time: string
  message: string
  details?: Record<string, unknown>
}

const accounts = ref<AwsAccountOption[]>([])
const regions = ref<string[]>([])
const vpcs = ref<SelectOption[]>([])
const osOptions = ref<SelectOption[]>([])
const form = reactive({
  accountId: null as number | null,
  region: '',
  vpcId: '',
  os: '',
})
const loadingInitial = ref(true)
const loadingVpcs = ref(false)
const busy = ref(false)
const result = ref<Record<string, unknown> | null>(null)
const progress = ref<ProgressEntry[]>([])
const canDeploy = computed(() => form.accountId && form.region && form.vpcId && form.os)
const resultText = computed(() => result.value ? JSON.stringify(result.value, null, 2) : '')

const stageLabels: Record<string, string> = {
  validating: '開始驗證部署輸入',
  resources_ready: '網路資源已就緒',
  root_password_generated: 'root 密碼已產生',
  instance_launched: 'EC2 執行個體已啟動',
  waiting_for_running: '等待執行個體進入 running',
  instance_running: '執行個體已進入 running',
  waiting_for_public_dns: '等待公網 DNS',
  public_dns_ready: '公網 DNS 已就緒',
  waiting_for_status_checks: '等待狀態檢查',
  status_check_progress: '狀態檢查進度',
  status_checks_passed: '狀態檢查已通過',
  waiting_for_cloud_init: '等待 cloud-init 完成',
  cloud_init_complete: 'cloud-init 已完成',
}

function errorMessage(error: any, fallback: string) {
  return error?.data?.error || error?.data?.message || error?.message || fallback
}

function appendProgress(message: string, details?: Record<string, unknown>) {
  progress.value.push({
    time: new Date().toLocaleTimeString('zh-TW'),
    message,
    ...(details ? { details } : {}),
  })
}

async function loadRegions(accountId: number) {
  regions.value = []
  Object.assign(form, { region: '', vpcId: '' })
  try {
    const payload = await $fetch<{ regions: string[] }>('/api/ec2/regions', {
      query: { account_id: accountId },
    })
    regions.value = payload.regions || []
  }
  catch (error) {
    toast.error(errorMessage(error, '載入 EC2 Region 失敗'))
  }
}

async function loadInitialOptions() {
  loadingInitial.value = true
  try {
    const [accountPayload, osPayload] = await Promise.all([
      $fetch<{ accounts: AwsAccountOption[] }>('/api/accounts'),
      $fetch<{ os: SelectOption[] }>('/api/ec2/os-options'),
    ])
    accounts.value = accountPayload.accounts.filter(account => account.enabled)
    form.accountId = accounts.value.find(account => account.isDefault)?.id || accounts.value[0]?.id || null
    osOptions.value = osPayload.os || []
    form.os ||= osOptions.value[0]?.value || ''
    if (form.accountId)
      await loadRegions(form.accountId)
  }
  catch (error) {
    toast.error(errorMessage(error, '載入 EC2 部署選項失敗'))
  }
  finally {
    loadingInitial.value = false
  }
}

async function loadVpcs(region: string) {
  vpcs.value = []
  form.vpcId = ''
  if (!form.accountId || !region)
    return

  loadingVpcs.value = true
  const requestedRegion = region
  try {
    const payload = await $fetch<{ vpcs: SelectOption[] }>('/api/ec2/vpcs', {
      query: { account_id: form.accountId, region },
    })
    if (form.region === requestedRegion)
      vpcs.value = payload.vpcs || []
  }
  catch (error) {
    toast.error(errorMessage(error, '載入 VPC 失敗'))
  }
  finally {
    if (form.region === requestedRegion)
      loadingVpcs.value = false
  }
}

async function readEventStream(response: Response) {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(payload.error || `請求失敗（HTTP ${response.status}）`)
  }
  const reader = response.body?.getReader()
  if (!reader)
    throw new Error('部署事件串流不可用')

  const decoder = new TextDecoder()
  let buffer = ''
  let finalResult: Record<string, unknown> | null = null
  let finalError = ''

  function processBlock(block: string) {
    const lines = block.split('\n')
    const eventName = lines.find(line => line.startsWith('event: '))?.slice(7) || 'message'
    const dataText = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n') || '{}'
    const payload = JSON.parse(dataText) as Record<string, any>
    if (eventName === 'progress')
      appendProgress(stageLabels[payload.stage] || payload.stage || '部署進度', payload)
    else if (eventName === 'result')
      finalResult = payload
    else if (eventName === 'error')
      finalError = payload.error || payload.message || '部署失敗'
  }

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replaceAll('\r\n', '\n')
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      processBlock(buffer.slice(0, boundary))
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf('\n\n')
    }
    if (done)
      break
  }
  if (buffer.trim())
    processBlock(buffer)
  if (finalError)
    throw new Error(finalError)
  return finalResult || {}
}

async function deployEc2() {
  if (!canDeploy.value || busy.value)
    return
  busy.value = true
  result.value = null
  appendProgress('開始部署一般 EC2')
  try {
    const response = await fetch('/api/ec2/deploy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account_id: form.accountId,
        region: form.region,
        vpc_id: form.vpcId,
        os: form.os,
      }),
    })
    result.value = await readEventStream(response)
    appendProgress('一般 EC2 部署流程完成', result.value)
    toast.success('一般 EC2 部署流程完成')
  }
  catch (error) {
    const message = errorMessage(error, 'EC2 部署失敗')
    appendProgress(message)
    toast.error(message)
  }
  finally {
    busy.value = false
  }
}

async function copyResult() {
  if (!resultText.value)
    return
  await navigator.clipboard.writeText(resultText.value)
  toast.success('部署結果已複製')
}

function downloadResult() {
  if (!resultText.value)
    return
  const blob = new Blob([resultText.value], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `aws-ec2-result-${new Date().toISOString().replaceAll(':', '-')}.json`
  link.click()
  URL.revokeObjectURL(url)
}

watch(() => form.accountId, async (accountId, previous) => {
  if (!accountId || accountId === previous)
    return
  await loadRegions(accountId)
})
watch(() => form.region, loadVpcs)
onMounted(loadInitialOptions)
</script>

<template>
  <div class="flex w-full flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 class="text-2xl font-bold">
          EC2 部署
        </h2>
        <p class="text-sm text-muted-foreground">
          在一般 AWS Region 建立可從公網連線的 EC2 執行個體
        </p>
      </div>
      <Button variant="outline" size="sm" :disabled="loadingInitial || busy" @click="loadInitialOptions">
        <Loader2 v-if="loadingInitial" class="mr-2 h-4 w-4 animate-spin" />
        <RefreshCw v-else class="mr-2 h-4 w-4" />
        重新載入選項
      </Button>
    </div>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2 text-base">
          <Server class="h-4 w-4" />
          部署參數
        </CardTitle>
        <CardDescription>一般 EC2 固定使用 t3.nano，部署後會自動加入機器總覽</CardDescription>
      </CardHeader>
      <CardContent class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div class="grid gap-2">
          <Label for="ec2-account">AWS 帳號</Label>
          <select id="ec2-account" v-model.number="form.accountId" class="h-9 rounded-md border bg-background px-3 text-sm" :disabled="loadingInitial || busy">
            <option :value="null" disabled>
              請選擇 AWS 帳號
            </option>
            <option v-for="account in accounts" :key="account.id" :value="account.id">
              {{ account.name }}{{ account.isDefault ? '（預設）' : '' }}
            </option>
          </select>
        </div>
        <div class="grid gap-2">
          <Label for="ec2-region">Region</Label>
          <select id="ec2-region" v-model="form.region" class="h-9 rounded-md border bg-background px-3 text-sm" :disabled="!form.accountId || loadingInitial || busy">
            <option value="">
              請選擇 Region
            </option>
            <option v-for="region in regions" :key="region" :value="region">
              {{ region }}
            </option>
          </select>
        </div>
        <div class="grid gap-2">
          <Label for="ec2-vpc">VPC</Label>
          <select id="ec2-vpc" v-model="form.vpcId" class="h-9 rounded-md border bg-background px-3 text-sm" :disabled="!form.region || loadingVpcs || busy">
            <option value="">
              {{ loadingVpcs ? '載入中...' : '請選擇 VPC' }}
            </option>
            <option v-for="vpc in vpcs" :key="vpc.value" :value="vpc.value">
              {{ vpc.label }}
            </option>
          </select>
        </div>
        <div class="grid gap-2">
          <Label for="ec2-os">作業系統</Label>
          <select id="ec2-os" v-model="form.os" class="h-9 rounded-md border bg-background px-3 text-sm" :disabled="loadingInitial || busy">
            <option value="">
              請選擇作業系統
            </option>
            <option v-for="option in osOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </div>
      </CardContent>
      <CardFooter class="justify-end border-t pt-4">
        <Button :disabled="!canDeploy || busy" @click="deployEc2">
          <Loader2 v-if="busy" class="mr-2 h-4 w-4 animate-spin" />
          部署 EC2
        </Button>
      </CardFooter>
    </Card>

    <div class="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader class="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle class="text-base">
              本次部署進度
            </CardTitle>
            <CardDescription>EC2 建立與就緒狀態會即時顯示於此</CardDescription>
          </div>
          <Button variant="ghost" size="icon" title="清空進度" :disabled="!progress.length || busy" @click="progress = []">
            <Trash2 class="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent>
          <div v-if="!progress.length" class="py-8 text-center text-sm text-muted-foreground">
            尚未執行部署
          </div>
          <ScrollArea v-else class="h-80 rounded-md border">
            <div class="divide-y">
              <div v-for="(entry, index) in progress" :key="index" class="p-3 text-sm">
                <div class="flex gap-2">
                  <span class="shrink-0 font-mono text-xs text-muted-foreground">{{ entry.time }}</span>
                  <span>{{ entry.message }}</span>
                </div>
                <pre v-if="entry.details" class="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">{{ JSON.stringify(entry.details, null, 2) }}</pre>
              </div>
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle class="text-base">
              部署結果
            </CardTitle>
            <CardDescription>包含 EC2 連線資訊與 root 密碼，請妥善保存</CardDescription>
          </div>
          <div class="flex gap-1">
            <Button variant="ghost" size="icon" title="複製結果" :disabled="!result" @click="copyResult">
              <Clipboard class="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" title="下載 JSON" :disabled="!result" @click="downloadResult">
              <Download class="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div v-if="!result" class="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 v-if="busy" class="mr-2 h-4 w-4 animate-spin" />
            {{ busy ? '部署流程執行中' : '尚無部署結果' }}
          </div>
          <div v-else class="relative">
            <Check class="absolute right-3 top-3 h-4 w-4 text-green-600" />
            <pre class="h-80 overflow-auto rounded-md border bg-muted/40 p-3 pr-10 text-xs">{{ resultText }}</pre>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
