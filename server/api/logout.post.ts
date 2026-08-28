// POST /api/logout：清除 session cookie。
// 前端側邊欄登出按鈕呼叫後導向 /login；IdP 端的 SSO session 不受影響。
import { buildClearedSessionCookie } from "../utils/auth.js";
import { jsonResponse } from "../utils/http.js";

export default defineEventHandler((event) => {
  setHeader(event, "Set-Cookie", buildClearedSessionCookie());
  return jsonResponse({ ok: true });
});
