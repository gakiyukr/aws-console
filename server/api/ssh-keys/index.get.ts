// GET /api/ssh-keys：列出設定頁管理的機器登入公鑰。
// 公鑰本身為公開資料，完整回傳內容以利設定頁檢視與部署表單顯示。
import { listSshPublicKeys } from "../../utils/db.js";
import { jsonResponse } from "../../utils/http.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  const keys = await listSshPublicKeys(env.DB);
  return jsonResponse({ keys });
});
