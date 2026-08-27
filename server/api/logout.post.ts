// POST /api/logout：清除 session 與 CSRF cookie。
// 前端側邊欄登出按鈕呼叫後導向 /login。
import {
  buildClearedCsrfCookie,
  buildClearedSessionCookie,
} from "../utils/auth.js";

export default defineEventHandler((event) => {
  setHeader(event, "Set-Cookie", [
    buildClearedSessionCookie(),
    buildClearedCsrfCookie(),
  ]);
  return jsonResponse({ ok: true });
});
