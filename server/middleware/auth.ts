// Nitro 伺服器中介層：/api/** 認證守衛。
// 放行清單：SSO 登入流程（/api/auth/login、/api/auth/callback）與
// session 查詢（供前端判斷導向）及 Nuxt 唯讀圖示端點。其餘 /api/**
// 一律要求有效 session，且 session 內 email 必須在 OIDC 允許清單中，
// 否則回 401 JSON。頁面路由交由前端中介層導向 /login。
import { getSessionFromRequest, parseSessionValue } from "../utils/auth.js";
import { isAllowedEmail, isOidcConfigured } from "../utils/oidc.js";

// 不需認證的 API 路徑（相對於 /api）
const PUBLIC_API_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/callback",
  "/api/session",
]);

export default defineEventHandler(async (event) => {
  const path = event.path.split("?")[0];

  if (
    !path.startsWith("/api/")
    || PUBLIC_API_PATHS.has(path)
    || path.startsWith("/api/_nuxt_icon/")
  ) {
    return;
  }

  const env = event.context.cloudflare?.env;
  const secret = env?.SESSION_SECRET;

  // 未設定 secrets 或 OIDC 時直接拒絕，fail closed
  if (!secret || !isOidcConfigured(env)) {
    throw createError({
      statusCode: 503,
      message: "伺服器尚未完成認證設定",
    });
  }

  const session = getSessionFromRequest(event.node.req);
  const payload = session ? await parseSessionValue(session, secret) : null;
  if (!payload?.email || !isAllowedEmail(env, payload.email)) {
    // createError 中斷後續處理；data.error 維持統一錯誤格式
    throw createError({
      statusCode: 401,
      message: "未登入或 session 已失效",
      data: { error: "未登入或 session 已失效" },
    });
  }
});
