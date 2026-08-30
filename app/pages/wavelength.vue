<script setup lang="ts">
import { Check, Clipboard, Download, Loader2, RefreshCw, Trash2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { regionLabel } from '~/lib/regions'

useSeoMeta({ title: 'Wavelength 部署 - AWS 主控台' })

interface SelectOption {
  value: string
  label: string
}

interface AwsAccountOption { id: number, name: string, enabled: boolean, isDefault: boolean }

interface ExistingInstance {
  instance_id: string
  state: string
  instance_type: string
  private_ip: string
  private_dns_name: string
  public_dns_name: string
  subnet_id: string
  vpc_id: string
  availability_zone: string
}

interface ProgressEntry {
  time: string
  message: string
  details?: Record<string, unknown>
}

const regions = ref<string[]>([])
const zones = ref<string[]>([])
const vpcs = ref<SelectOption[]>([])
const instanceTypes = ref<string[]>([])
const osOptions = ref<SelectOption[]>([])
const existingInstances = ref<ExistingInstance[]>([])
const accounts = ref<AwsAccountOption[]>([])

const form = reactive({
  accountId: null as number | null,
  region: '',
  zone: '',
  vpcId: '',
  instanceType: '',
  os: '',
  enableForwarder: false,
  useExistingInstance: false,
  existingInstanceId: '',
})

const loadingInitial = ref(true)
const loadingRegion = ref(false)
const loadingTypes = ref(false)
const loadingInstances = ref(false)
const busyAction = ref('')
const result = ref<Record<string, unknown> | null>(null)
const progress = ref<ProgressEntry[]>([])

const isBusy = computed(() => Boolean(busyAction.value))
const canInitialize = computed(() => form.accountId && form.region && form.zone && form.vpcId)
const canDeployWavelength = computed(() => canInitialize.value && form.instanceType && form.os)
const canDeployExistingForwarder = computed(() => canInitialize.value && form.os && form.existingInstanceId)
const resultText = computed(() => result.value ? JSON.stringify(result.value, null, 2) : '')

const stageLabels: Record<string, string> = {
  validating: '開始驗證部署輸入',
  validating_existing_forwarder: '驗證既有 WL forwarder 輸入',
  root_password_generated: 'root 密碼已產生',
  zone_ready: 'Wavelength Zone 已就緒',
  resources_ready: '網路資源已就緒',
  instance_launched: '執行個體已啟動',
  waiting_for_running: '等待執行個體進入 running',
  instance_running: '執行個體已進入 running',
  waiting_for_public_dns: '等待公網 DNS',
  public_dns_ready: '公網 DNS 已就緒',
  waiting_for_status_checks: '等待狀態檢查',
  status_check_progress: '狀態檢查進度',
  status_checks_passed: '狀態檢查已通過',
  waiting_for_cloud_init: '等待 cloud-init 完成',
  cloud_init_complete: 'cloud-init 已完成',
  preparing_forwarder: '準備區域型 SSH forwarder',
  forwarder_launched: 'SSH forwarder 已啟動',
  waiting_for_forwarder_running: '等待 forwarder 進入 running',
  forwarder_running: 'forwarder 已進入 running',
  waiting_for_forwarder_public_dns: '等待 forwarder 公網 DNS',
  forwarder_public_dns_ready: 'forwarder 公網 DNS 已就緒',
  waiting_for_forwarder_status_checks: '等待 forwarder 狀態檢查',
  forwarder_status_checks_passed: 'forwarder 狀態檢查已通過',
  waiting_for_forwarder_cloud_init: '等待 forwarder cloud-init 完成',
  forwarder_cloud_init_complete: 'forwarder cloud-init 已完成',
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

async function loadInitialOptions() {
  loadingInitial.value = true
  const [accountResult, osResult] = await Promise.allSettled([
    $fetch<{ accounts: AwsAccountOption[] }>('/api/accounts'),
    $fetch<{ os: SelectOption[] }>('/api/wavelength/os-options'),
  ])
  try {
    if (accountResult.status === 'fulfilled') {
      accounts.value = accountResult.value.accounts.filter(account => account.enabled)
      if (!form.accountId)
        form.accountId = accounts.value.find(account => account.isDefault)?.id || accounts.value[0]?.id || null
      if (form.accountId) {
        const regionPayload = await $fetch<{ regions: string[] }>('/api/wavelength/regions', { query: { account_id: form.accountId } })
        regions.value = regionPayload.regions || []
      }
    }
    else {
      toast.error(errorMessage(accountResult.reason, '載入 AWS 帳號失敗'))
    }

    if (osResult.status === 'fulfilled')
      osOptions.value = osResult.value.os || []
    else
      toast.error(errorMessage(osResult.reason, '載入作業系統選項失敗'))

    if (!form.os && osOptions.value.length)
      form.os = osOptions.value[0]!.value
  }
  finally {
    loadingInitial.value = false
  }
}

async function loadRegionOptions(region: string) {
  zones.value = []
  vpcs.value = []
  instanceTypes.value = []
  existingInstances.value = []
  Object.assign(form, { zone: '', vpcId: '', instanceType: '', existingInstanceId: '' })
  if (!form.accountId || !region)
    return

  loadingRegion.value = true
  const requestedRegion = region
  try {
    const [zonePayload, vpcPayload] = await Promise.all([
      $fetch<{ zones: string[] }>('/api/wavelength/zones', { query: { account_id: form.accountId, region } }),
      $fetch<{ vpcs: SelectOption[] }>('/api/wavelength/vpcs', { query: { account_id: form.accountId, region } }),
    ])
    if (form.region !== requestedRegion)
      return
    zones.value = zonePayload.zones || []
    vpcs.value = vpcPayload.vpcs || []
  }
  catch (error) {
    toast.error(errorMessage(error, '載入 Zone 或 VPC 失敗'))
  }
  finally {
    if (form.region === requestedRegion)
      loadingRegion.value = false
  }
}

async function loadInstanceTypes(zone: string) {
  instanceTypes.value = []
  form.instanceType = ''
  if (!form.region || !zone)
    return

  loadingTypes.value = true
  const requestedZone = zone
  try {
    const payload = await $fetch<{ instance_types: string[] }>('/api/wavelength/instance-types', {
      query: { account_id: form.accountId, region: form.region, zone },
    })
    if (form.zone !== requestedZone)
      return
    instanceTypes.value = payload.instance_types || []
    form.instanceType = instanceTypes.value[0] || ''
  }
  catch (error) {
    toast.error(errorMessage(error, '載入執行個體類型失敗'))
  }
  finally {
    if (form.zone === requestedZone)
      loadingTypes.value = false
  }
}

async function loadExistingInstances() {
  existingInstances.value = []
  form.existingInstanceId = ''
  if (!form.useExistingInstance || !form.region || !form.zone || !form.vpcId)
    return

  loadingInstances.value = true
  try {
    const payload = await $fetch<{ instances: ExistingInstance[] }>('/api/wavelength/instances', {
      query: { account_id: form.accountId, region: form.region, zone: form.zone, vpc_id: form.vpcId },
    })
    existingInstances.value = payload.instances || []
    form.existingInstanceId = existingInstances.value[0]?.instance_id || ''
  }
  catch (error) {
    toast.error(errorMessage(error, '載入既有 Wavelength 執行個體失敗'))
  }
  finally {
    loadingInstances.value = false
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

async function runJsonAction(action: string, endpoint: string, payload: Record<string, unknown>, success: string) {
  busyAction.value = action
  result.value = null
  appendProgress(`POST ${endpoint}`)
  try {
    result.value = await $fetch<Record<string, unknown>>(endpoint, { method: 'POST', body: payload })
    appendProgress(success, result.value)
    toast.success(success)
  }
  catch (error) {
    const message = errorMessage(error, '操作失敗')
    appendProgress(message)
    toast.error(message)
  }
  finally {
    busyAction.value = ''
  }
}

async function runDeployAction(action: string, endpoint: string, payload: Record<string, unknown>, success: string) {
  busyAction.value = action
  result.value = null
  appendProgress(`POST ${endpoint}`)
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    result.value = await readEventStream(response)
    appendProgress(success, result.value)
    toast.success(success)
  }
  catch (error) {
    const message = errorMessage(error, '部署失敗')
    appendProgress(message)
    toast.error(message)
  }
  finally {
    busyAction.value = ''
  }
}

function initializeZone() {
  return runJsonAction('init', '/api/wavelength/init', {
    account_id: form.accountId,
    region: form.region,
    zone: form.zone,
    vpc_id: form.vpcId,
  }, 'Wavelength Zone 初始化完成')
}

function deployWavelength() {
  return runDeployAction('wavelength', '/api/wavelength/deploy', {
    account_id: form.accountId,
    region: form.region,
    zone: form.zone,
    vpc_id: form.vpcId,
    instance_type: form.instanceType,
    os: form.os,
    enable_forwarder: form.enableForwarder,
  }, 'Wavelength EC2 部署流程完成')
}

function deployExistingForwarder() {
  return runDeployAction('forwarder', '/api/wavelength/forwarder', {
    account_id: form.accountId,
    region: form.region,
    zone: form.zone,
    vpc_id: form.vpcId,
    instance_id: form.existingInstanceId,
    os: form.os,
  }, '既有 Wavelength EC2 的 forwarder 部署完成')
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
  link.download = `aws-wavelength-result-${new Date().toISOString().replaceAll(':', '-')}.json`
  link.click()
  URL.revokeObjectURL(url)
}

watch(() => form.region, loadRegionOptions)
watch(() => form.accountId, async (accountId, previous) => {
  if (previous === undefined || accountId === previous)
    return
  regions.value = []
  Object.assign(form, { region: '', zone: '', vpcId: '', instanceType: '', existingInstanceId: '' })
  if (!accountId)
    return
  try {
    const payload = await $fetch<{ regions: string[] }>('/api/wavelength/regions', { query: { account_id: accountId } })
    regions.value = payload.regions || []
  }
  catch (error) {
    toast.error(errorMessage(error, '載入 Wavelength Region 失敗'))
  }
})
watch(() => form.zone, async (zone) => {
  await loadInstanceTypes(zone)
  await loadExistingInstances()
})
watch(() => form.vpcId, loadExistingInstances)
watch(() => form.useExistingInstance, loadExistingInstances)

onMounted(loadInitialOptions)
</script>

<template>
  <div class="flex w-full flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 class="text-2xl font-bold">
          Wavelength 部署
        </h2>
        <p class="text-sm text-muted-foreground">
          初始化網路資源並部署 Wavelength EC2 與 SSH forwarder
        </p>
      </div>
      <Button variant="outline" size="sm" :disabled="loadingInitial || isBusy" @click="loadInitialOptions">
        <Loader2 v-if="loadingInitial" class="mr-2 h-4 w-4 animate-spin" />
        <RefreshCw v-else class="mr-2 h-4 w-4" />
        重新載入選項
      </Button>
    </div>

    <Card>
      <CardHeader>
        <CardTitle class="text-base">
          部署參數
        </CardTitle>
        <CardDescription>選項直接從所選 AWS 帳號查詢</CardDescription>
      </CardHeader>
      <CardContent class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div class="grid gap-2">
          <Label for="wl-account">AWS 帳號</Label>
          <select id="wl-account" v-model.number="form.accountId" class="h-9 rounded-md border bg-background px-3 text-sm" :disabled="loadingInitial || isBusy">
            <option :value="null" disabled>
              請選擇 AWS 帳號
            </option>
            <option v-for="account in accounts" :key="account.id" :value="account.id">
              {{ account.name }}{{ account.isDefault ? '（預設）' : '' }}
            </option>
          </select>
        </div>
        <div class="grid gap-2">
          <Label for="wl-region">Region</Label>
          <select id="wl-region" v-model="form.region" class="h-9 rounded-md border bg-background px-3 text-sm" :disabled="loadingInitial || isBusy">
            <option value="">
              請選擇 Region
            </option>
            <option v-for="region in regions" :key="region" :value="region">
              {{ regionLabel(region) }}
            </option>
          </select>
        </div>
        <div class="grid gap-2">
          <Label for="wl-zone">Wavelength Zone</Label>
          <select id="wl-zone" v-model="form.zone" class="h-9 rounded-md border bg-background px-3 text-sm" :disabled="!form.region || loadingRegion || isBusy">
            <option value="">
              {{ loadingRegion ? '載入中...' : '請選擇 Zone' }}
            </option>
            <option v-for="zone in zones" :key="zone" :value="zone">
              {{ zone }}
            </option>
          </select>
        </div>
        <div class="grid gap-2">
          <Label for="wl-vpc">VPC</Label>
          <select id="wl-vpc" v-model="form.vpcId" class="h-9 rounded-md border bg-background px-3 text-sm" :disabled="!form.region || loadingRegion || isBusy">
            <option value="">
              {{ loadingRegion ? '載入中...' : '請選擇 VPC' }}
            </option>
            <option v-for="vpc in vpcs" :key="vpc.value" :value="vpc.value">
              {{ vpc.label }}
            </option>
          </select>
        </div>
        <div class="grid gap-2">
          <Label for="wl-type">WL Instance Type</Label>
          <select id="wl-type" v-model="form.instanceType" class="h-9 rounded-md border bg-background px-3 text-sm" :disabled="!form.zone || loadingTypes || isBusy">
            <option value="">
              {{ loadingTypes ? '載入中...' : '請選擇機型' }}
            </option>
            <option v-for="type in instanceTypes" :key="type" :value="type">
              {{ type }}
            </option>
          </select>
        </div>
        <div class="grid gap-2">
          <Label for="wl-os">作業系統</Label>
          <select id="wl-os" v-model="form.os" class="h-9 rounded-md border bg-background px-3 text-sm" :disabled="loadingInitial || isBusy">
            <option value="">
              請選擇作業系統
            </option>
            <option v-for="option in osOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </div>
        <div class="flex items-end pb-2">
          <div class="flex items-center gap-2">
            <Checkbox id="wl-forwarder" :model-value="form.enableForwarder" :disabled="isBusy" @update:model-value="form.enableForwarder = $event === true" />
            <Label for="wl-forwarder">部署 WL 時同時建立 SSH forwarder</Label>
          </div>
        </div>
      </CardContent>
      <CardFooter class="flex flex-wrap gap-2 border-t pt-4">
        <Button variant="outline" :disabled="!canInitialize || isBusy" @click="initializeZone">
          <Loader2 v-if="busyAction === 'init'" class="mr-2 h-4 w-4 animate-spin" />
          初始化 WL Zone
        </Button>
        <Button :disabled="!canDeployWavelength || isBusy" @click="deployWavelength">
          <Loader2 v-if="busyAction === 'wavelength'" class="mr-2 h-4 w-4 animate-spin" />
          部署 Wavelength EC2
        </Button>
      </CardFooter>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle class="text-base">
          既有 Wavelength EC2
        </CardTitle>
        <CardDescription>為指定 VPC 與 Zone 內的既有執行個體建立區域型 SSH forwarder</CardDescription>
      </CardHeader>
      <CardContent class="grid gap-4 md:grid-cols-[auto_1fr] md:items-end">
        <div class="flex h-9 items-center gap-2">
          <Checkbox id="existing-forwarder" :model-value="form.useExistingInstance" :disabled="isBusy" @update:model-value="form.useExistingInstance = $event === true" />
          <Label for="existing-forwarder">載入既有 WL EC2</Label>
        </div>
        <div class="grid gap-2">
          <Label for="existing-instance">目標執行個體</Label>
          <select id="existing-instance" v-model="form.existingInstanceId" class="h-9 rounded-md border bg-background px-3 text-sm" :disabled="!form.useExistingInstance || loadingInstances || isBusy">
            <option value="">
              {{ loadingInstances ? '載入中...' : '請選擇既有執行個體' }}
            </option>
            <option v-for="instance in existingInstances" :key="instance.instance_id" :value="instance.instance_id">
              {{ instance.instance_id }} | {{ instance.private_ip || '無私網 IP' }} | {{ instance.state }} | {{ instance.instance_type }}
            </option>
          </select>
        </div>
      </CardContent>
      <CardFooter class="border-t pt-4">
        <Button variant="outline" :disabled="!canDeployExistingForwarder || isBusy" @click="deployExistingForwarder">
          <Loader2 v-if="busyAction === 'forwarder'" class="mr-2 h-4 w-4 animate-spin" />
          部署既有 WL forwarder
        </Button>
      </CardFooter>
    </Card>

    <div class="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader class="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle class="text-base">
              本次操作進度
            </CardTitle>
            <CardDescription>SSE 部署事件會即時顯示於此</CardDescription>
          </div>
          <Button variant="ghost" size="icon" title="清空進度" :disabled="!progress.length || isBusy" @click="progress = []">
            <Trash2 class="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent>
          <div v-if="!progress.length" class="py-8 text-center text-sm text-muted-foreground">
            尚未執行操作
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
            <CardDescription>包含連線資訊與新建資源 ID，請妥善保存密碼</CardDescription>
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
            <Loader2 v-if="isBusy" class="mr-2 h-4 w-4 animate-spin" />
            {{ isBusy ? '部署流程執行中' : '尚無部署結果' }}
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
