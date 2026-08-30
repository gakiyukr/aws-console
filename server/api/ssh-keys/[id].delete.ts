// DELETE /api/ssh-keys/:id：自公鑰庫移除 SSH 公鑰。
// 已被部署使用的金鑰不影響既有執行個體，僅影響後續部署的選項。
import { deleteSshPublicKey } from "../../utils/db.js";
import { errorResponse, jsonResponse } from "../../utils/http.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  const id = Number(getRouterParam(event, "id"));
  if (!Number.isInteger(id) || id <= 0) {
    return errorResponse(400, "公鑰 ID 無效。");
  }
  const deleted = await deleteSshPublicKey(env.DB, id);
  if (!deleted) {
    return errorResponse(404, "公鑰不存在。");
  }
  return jsonResponse({ ok: true });
});
