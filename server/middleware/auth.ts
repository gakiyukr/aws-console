// Nitro 伺服器中介層：/api/** 認證守衛。
// 放行清單：登入流程所需端點（csrf/login）與 session 查詢（供前端
// 判斷導向）。其餘 /api/** 一律要求有效 session，否則回 401 JSON。
import { getSessionFromRequest, verifySessionValue } from "../utils/auth.js";

// 不需認證的 API 路徑（相對於 /api）
const PUBLIC_API_PATHS = new Set(["/api/csrf", "/api/login", "/api/session"]);

export default defineEventHandler(async (event) => {
  const path = event.path.split("?")[0];

  // 僅攔截 /api/**；頁面路由交由前端中介層導向 /login
  if (!path.startsWith("/api/") || PUBLIC_API_PATHS.has(path)) {
    return;
  }

  const env = event.context.cloudflare?.env;
  const password = env?.APP_PASSWORD;
  const secret = env?.SESSION_SECRET;

  // 未設定 secrets 時直接拒絕，避免「空密碼可登入」的退化行為
  if (!password || !secret) {
    throw createError({
      statusCode: 503,
      message: "伺服器尚未設定認證環境變數",
    });
  }

  const session = getSessionFromRequest(event.node.req);
  const valid = session && (await verifySessionValue(session, secret, password));
  if (!valid) {
    // createError 中斷後續處理；data.error 維持統一錯誤格式
    throw createError({
      statusCode: 401,
      message: "未登入或 session 已失效",
      data: { error: "未登入或 session 已失效" },
    });
  }
});
