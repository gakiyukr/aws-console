import tailwindcss from '@tailwindcss/vite';

const buildEnv = (globalThis as {
  process?: { env?: Record<string, string | undefined> }
}).process?.env ?? {};
const cloudflareWorkerName = buildEnv.CLOUDFLARE_WORKER_NAME || 'aws-console';
const cloudflareD1DatabaseName = buildEnv.CLOUDFLARE_D1_DATABASE_NAME || 'aws-console';
// D1 ID 不是機密；保留專案預設值，避免 GitHub 建置缺少本機 .env 時遺失 DB binding。
// 部署到其他資料庫時仍可由 CLOUDFLARE_D1_DATABASE_ID 覆寫。
const defaultCloudflareD1DatabaseId = '95917b87-defb-4175-a060-875dc58d8796';
const cloudflareD1DatabaseId = buildEnv.CLOUDFLARE_D1_DATABASE_ID || defaultCloudflareD1DatabaseId;
const d1Databases = cloudflareD1DatabaseId
  ? [{
      binding: 'DB',
      database_name: cloudflareD1DatabaseName,
      database_id: cloudflareD1DatabaseId,
      migrations_dir: '../../server/db/migrations',
    }]
  : [];

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  devtools: { enabled: true },

  css: ['~/assets/css/tailwind.css'],
  vite: {
    plugins: [tailwindcss()]
  },

  components: [
    {
      path: '~/components',
      extensions: ['.vue']
    }
  ],

  modules: [
    'shadcn-nuxt',
    '@vueuse/nuxt',
    '@nuxt/eslint',
    '@nuxt/icon',
    '@pinia/nuxt',
    '@nuxtjs/color-mode',
    '@nuxt/fonts',
    '@nuxthub/core'
  ],

  shadcn: {
    /**
     * Prefix for all the imported component
     */
    prefix: '',
    /**
     * Directory that the component lives in.
     * @default "~/components/ui"
     */
    componentDir: '~/components/ui'
  },

  colorMode: {
    classSuffix: ''
  },

  eslint: {
    config: {
      standalone: false
    }
  },

  fonts: {
    defaults: {
      weights: [300, 400, 500, 600, 700, 800]
    }
  },

  imports: {
    dirs: ['./lib']
  },

  compatibilityDate: '2026-03-13',

  // 部署目標：單一 Cloudflare Worker（SPA 前端 + Nitro server API 同一程序）
  nitro: {
    preset: 'cloudflare_module',
    cloudflare: {
      // 產物由 Wrangler 部署；keep_vars 保留 Dashboard 中的 session 與憑證加密 secrets。
      deployConfig: true,
      nodeCompat: true,
      wrangler: {
        name: cloudflareWorkerName,
        keep_vars: true,
        d1_databases: d1Databases,
      },
    }
  }
});
