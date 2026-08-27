<script setup>
const error = useError()

const router = useRouter()

// 依錯誤狀態碼決定標題與說明；未知錯誤一律以 500 呈現，避免洩漏內部細節
const code = computed(() => error.value?.statusCode || 500)
const isNotFound = computed(() => code.value === 404)
</script>

<template>
  <div class="h-svh">
    <div class="m-auto h-full w-full flex flex-col items-center justify-center gap-2">
      <h1 class="text-[7rem] font-bold leading-tight">
        {{ code }}
      </h1>
      <span class="font-medium">{{ isNotFound ? '找不到頁面' : '發生錯誤' }}</span>
      <p class="text-center text-muted-foreground">
        {{ isNotFound
          ? '您要找的頁面不存在，或已被移除。'
          : '系統發生未預期的錯誤，請稍後再試。' }}
      </p>
      <div class="mt-6 flex gap-4">
        <Button variant="outline" @click="router.back()">
          返回上一頁
        </Button>
        <Button @click="router.push('/')">
          回到首頁
        </Button>
      </div>
    </div>
  </div>
</template>
