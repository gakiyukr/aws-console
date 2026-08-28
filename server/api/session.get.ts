// GET /api/session：回報目前請求是否帶有效 session。
// 供前端路由守衛在進入受保護頁面前查詢，未認證時導向 /login。
// 本端點在中介層放行清單中，未登入時回 200（authenticated: false）
// 而非 401，避免前端把「尚未登入」當成請求錯誤處理。
import { getSessionFromRequest, parseSessionValue } from "../utils/auth.js";
import { jsonResponse } from "../utils/http.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  const secret = env?.SESSION_SECRET;

  // secrets 未設定時視同未認證，與中介層的拒絕行為一致
  if (!secret) {
    return jsonResponse({ authenticated: false, user: null });
  }

  const session = getSessionFromRequest(event.node.req);
  const payload = session ? await parseSessionValue(session, secret) : null;
  const authenticated = Boolean(payload?.email);
  return jsonResponse({
    authenticated,
    user: authenticated ? { email: payload.email } : null,
  });
});
