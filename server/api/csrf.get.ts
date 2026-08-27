// GET /api/csrf：簽發 CSRF token（寫入 ec2_csrf cookie）。
// 登入頁送出 POST /api/login 前先呼叫本端點，login 端點以
// 「cookie 中的 token == header 中的 token」雙送出模式驗證。
import {
  buildCsrfCookie,
  generateCsrfToken,
  getCsrfTokenFromRequest,
} from "../utils/auth.js";
import { jsonResponse } from "../utils/http.js";

export default defineEventHandler((event) => {
  // 已有有效 token 時直接重用，避免每次造訪登入頁都輪換 token
  // （輪換會使多分頁場景下較早分頁的表單失效）
  const existing = getCsrfTokenFromRequest(event.node.req);
  const token = existing || generateCsrfToken();

  setHeader(event, "Set-Cookie", buildCsrfCookie(token));
  return jsonResponse({ csrfToken: token });
});
