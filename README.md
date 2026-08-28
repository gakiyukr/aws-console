# AWS 主控台

此專案整合 `aws-wavelength-console` 與 `ec2-power-console` 的核心能力，部署為單一 Cloudflare Worker：

- 管理 D1 清單內 EC2 執行個體的即時狀態與開機、關機操作。
- 建立及初始化 AWS Wavelength Zone 所需的子網、Carrier Gateway、路由表與安全群組。
- 以獨立工作流部署一般區域 EC2、Wavelength 執行個體與 SSH forwarder。
- 在部署成功後自動將建立的執行個體登錄至電源管理清單。
- 保存登入限流、電源操作與部署結果的稽核日誌。
- 在 D1 管理多組 AWS 帳號與主控台使用者；AWS Secret 以 AES-256-GCM 加密後儲存。

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

`pnpm dev:worker` 與 `pnpm deploy` 都會先檢查 `CLOUDFLARE_D1_DATABASE_ID`，避免啟動缺少 `DB` binding 的 Worker。

## Cloudflare 部署

先建立 D1 資料庫，將取得的資料庫 ID 設為 `CLOUDFLARE_D1_DATABASE_ID`，並依需要調整 Worker 與資料庫名稱。設定完成後建立 Worker 產物並套用 migration：

```bash
pnpm exec wrangler d1 create aws-console
pnpm build
pnpm exec wrangler --config .output/server/wrangler.json d1 migrations apply DB --remote
```

正式環境只需保留以下 Cloudflare secrets，不應寫入 D1、`.env` 或版本庫：

```bash
pnpm exec wrangler --config .output/server/wrangler.json secret put APP_PASSWORD
pnpm exec wrangler --config .output/server/wrangler.json secret put SESSION_SECRET
pnpm exec wrangler --config .output/server/wrangler.json secret put CREDENTIAL_ENCRYPTION_KEY
```

- `APP_PASSWORD`：僅在 D1 尚無使用者時，用於首次登入並建立 `admin`。建立完成後可移除。
- `SESSION_SECRET`：簽署登入 session，輪替後所有既有 session 失效。
- `CREDENTIAL_ENCRYPTION_KEY`：32 位元組 Base64 AES 主金鑰。遺失或更換後，既有 AWS 憑證無法解密。

可在本機產生兩個獨立的隨機 Base64 secret：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

首次登入後前往「帳號管理」新增 AWS Access Key。Access Key、Secret Access Key
與選填 Session Token 會在 Worker 內加密後寫入 D1；API 與頁面只會顯示 Access Key
尾四位。請勿將 `CREDENTIAL_ENCRYPTION_KEY` 放入 D1，否則密文失去隔離意義。

`0002_seed_legacy_machine.sql` 會以 `INSERT OR IGNORE` 將舊版
`ec2-power-console` 的 `SEA-1` 管理目標移入 D1；既有資料不會被覆寫或重複建立。
`0003_accounts_and_users.sql` 會建立 AWS 帳號與主控台使用者資料表，並為機器及
操作日誌加入 AWS 帳號關聯。建立第一個 AWS 帳號時，尚未關聯的舊機器會自動歸入該帳號。

完成 D1 與 secrets 設定後執行：

```bash
pnpm deploy
```

部署腳本會先檢查 D1 資料庫 ID，再建立 `.output` 內含 `DB` binding 的 Wrangler 設定並部署。`keep_vars` 會保留 Dashboard 中既有的 secrets。

## API 範圍

- `/api/machines`：EC2 管理清單與即時狀態。
- `/api/machines/:id/action`：白名單機器的開機或關機。
- `/api/accounts`：AWS 帳號與加密憑證管理；`/:id/test` 可驗證憑證。
- `/api/users`：D1 主控台使用者管理與密碼替換。
- `/api/ec2/*`：一般 EC2 的 Region、VPC、作業系統選項與部署流程。
- `/api/wavelength/*`：Wavelength 探索、初始化與部署流程。
- `/api/logs`：可依 `account_id`、`action`、`status`、`limit` 讀取稽核日誌。

所有 `/api` 端點（登入、CSRF 與 session 查詢除外）都要求有效登入 session。
