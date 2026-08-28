<script setup lang="ts">
import { ConfigProvider } from 'reka-ui'
import { Toaster } from '@/components/ui/sonner'
import 'vue-sonner/style.css'

const colorMode = useColorMode()
const color = computed(() => colorMode.value === 'dark' ? '#09090b' : '#ffffff')

useHead({
  meta: [
    { charset: 'utf-8' },
    { name: 'viewport', content: 'width=device-width, initial-scale=1' },
    { key: 'theme-color', name: 'theme-color', content: color },
  ],
  link: [
    { rel: 'icon', href: '/favicon.ico' },
  ],
  htmlAttrs: {
    lang: 'zh-Hant',
  },
})

const title = 'AWS 主控台'
const description = 'EC2 與 Wavelength 部署及電源管理主控台，基於 Cloudflare Workers 與 D1。'

useSeoMeta({
  title,
  description,
})

const router = useRouter()

defineShortcuts({
  'G-H': () => router.push('/'),
  'G-W': () => router.push('/wavelength'),
})

const textDirection = useTextDirection({ initialValue: 'ltr' })
const dir = computed(() => textDirection.value === 'rtl' ? 'rtl' : 'ltr')
</script>

<template>
  <Body class="overscroll-none antialiased bg-background text-foreground">
    <ConfigProvider :dir="dir">
      <div id="app" vaul-drawer-wrapper class="relative">
        <NuxtLayout>
          <NuxtPage />
        </NuxtLayout>
      </div>

      <Toaster :theme="colorMode.preference as any || 'system'" />
    </ConfigProvider>
  </Body>
</template>
