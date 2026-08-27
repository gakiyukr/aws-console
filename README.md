# AWS 主控台

此專案整合 `aws-wavelength-console` 與 `ec2-power-console` 的核心能力，部署為單一 Cloudflare Worker：

- 管理 D1 清單內 EC2 執行個體的即時狀態與開機、關機操作。
- 建立及初始化 AWS Wavelength Zone 所需的子網、Carrier Gateway、路由表與安全群組。
- 部署 Wavelength 執行個體、一般區域 EC2 與 SSH forwarder。
- 在部署成功後自動將建立的執行個體登錄至電源管理清單。
- 保存登入限流、電源操作與部署結果的稽核日誌。

## 本機驗證

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

複製 `.env.example` 為 `.env`，並複製 `.dev.vars.example` 為 `.dev.vars` 後填入本機所需值。以 Cloudflare Worker 執行本機環境時，使用：

```bash
pnpm dev:worker
```

## Cloudflare 部署

先建立 D1 資料庫，將取得的資料庫 ID 設為 `CLOUDFLARE_D1_DATABASE_ID`，並依需要調整 Worker 與資料庫名稱：

```bash
pnpm exec wrangler d1 create aws-console
pnpm exec wrangler d1 migrations apply aws-console --remote --migrations-dir server/db/migrations
```

正式環境的敏感設定必須使用 Cloudflare secrets，不應寫入 `.env` 或版本庫：

```bash
pnpm exec wrangler secret put APP_PASSWORD
pnpm exec wrangler secret put SESSION_SECRET
pnpm exec wrangler secret put AWS_ACCESS_KEY_ID
pnpm exec wrangler secret put AWS_SECRET_ACCESS_KEY
```

完成 D1 與 secrets 設定後執行：

```bash
pnpm deploy
```

部署腳本會先檢查 D1 資料庫 ID，再建立 `.output` 內含 `DB` binding 的 Wrangler 設定並部署。`keep_vars` 會保留 Dashboard 中既有的 secrets。

## API 範圍

- `/api/machines`：EC2 管理清單與即時狀態。
- `/api/machines/:id/action`：白名單機器的開機或關機。
- `/api/wavelength/*`：Wavelength 探索、初始化與部署流程。
- `/api/logs`：可依 `action`、`status`、`limit` 讀取稽核日誌。

所有 `/api` 端點（登入、CSRF 與 session 查詢除外）都要求有效登入 session。
