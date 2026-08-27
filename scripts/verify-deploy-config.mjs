// 部署前確認 D1 binding 已具備可識別的資料庫 ID，避免產出沒有 DB 的 Worker。
import { existsSync } from 'node:fs';

if (existsSync('.env') && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile('.env');
}

if (!process.env.CLOUDFLARE_D1_DATABASE_ID) {
  console.error('缺少 CLOUDFLARE_D1_DATABASE_ID，請先建立 D1 資料庫並設定 .env 或環境變數。');
  process.exitCode = 1;
}
