// Nitro 伺服器中介層：/api/** 認證守衛 + 頁面路由的 SSR 重導。
// - /api/**：放行 SSO 登入流程、OOBE 初始設定與 session 查詢；其餘
//   一律要求有效 session（401 JSON）。
// - 頁面：受保護頁面未登入時 302 到 /login；尚未完成 SSO 設定時
//   導向 /setup 進入 OOBE；已登入者造訪 /login 或 /setup 導回主控台。
//   頁面守衛直接驗 cookie，不經內部子請求——Workers 免費方案 CPU
//   限制緊，SSR 內再打 /api/session 會超出限制。
import { getSessionFromRequest, parseSessionValue } from "../utils/auth.js";
import { getOidcConfigurationStatus, isAllowedEmail } from "../utils/oidc.js";

// 不需認證的 API 路徑（相對於 /api）
const PUBLIC_API_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/callback",
  "/api/session",
  "/api/setup/test",
  "/api/setup/start",
]);

// 受保護頁面（新增頁面時同步維護）；其餘非 /api 路徑視為靜態資源放行
const PROTECTED_PAGE_PATHS = new Set(["/", "/ec2", "/wavelength", "/logs", "/accounts", "/settings"]);
// 公開頁面：登入頁、OOBE 設定頁與示範用錯誤頁
const PUBLIC_PAGE_PATHS = new Set(["/login", "/setup", "/401", "/403", "/404", "/500", "/503"]);

export default defineEventHandler(async (event) => {
  const path = event.path.split("?")[0];

  if (path.startsWith("/api/")) {
    if (PUBLIC_API_PATHS.has(path) || path.startsWith("/api/_nuxt_icon/")) {
      return;
    }

    const env = event.context.cloudflare?.env;
    const secret = env?.SESSION_SECRET;
    const oidcStatus = await getOidcConfigurationStatus(env);

    // API 不得把基礎設施故障回報成未設定；reason 只包含可公開的診斷代碼。
    if (oidcStatus.state === "error" || !secret) {
      const reason = oidcStatus.state === "error" ? oidcStatus.reason : "session_secret_missing";
      throw createError({
        statusCode: 503,
        message: "認證服務目前無法使用",
        data: { error: "認證服務目前無法使用", reason },
      });
    }
    if (oidcStatus.state === "unconfigured") {
      throw createError({
        statusCode: 503,
        message: "伺服器尚未完成 SSO 初始設定",
        data: { error: "伺服器尚未完成 SSO 初始設定", reason: "sso_unconfigured" },
      });
    }

    const session = getSessionFromRequest(event.node.req);
    const payload = session ? await parseSessionValue(session, secret) : null;
    if (!payload?.email || !(await isAllowedEmail(env, payload.email))) {
      // createError 中斷後續處理；data.error 維持統一錯誤格式
      throw createError({
        statusCode: 401,
        message: "未登入或 session 已失效",
        data: { error: "未登入或 session 已失效" },
      });
    }
    return;
  }

  // ── 頁面路由守衛 ──
  const isProtectedPage = PROTECTED_PAGE_PATHS.has(path);
  const isLoginPage = path === "/login";
  const isSetupPage = path === "/setup";
  if (!isProtectedPage && !isLoginPage && !isSetupPage && !PUBLIC_PAGE_PATHS.has(path)) {
    return;
  }

  const env = event.context.cloudflare?.env;
  const secret = env?.SESSION_SECRET;
  const oidcStatus = await getOidcConfigurationStatus(env);

  const systemErrorReason = oidcStatus.state === "error"
    ? oidcStatus.reason
    : (!secret ? "session_secret_missing" : "");
  if (systemErrorReason) {
    if (path !== "/503") {
      return sendRedirect(event, `/503?reason=${encodeURIComponent(systemErrorReason)}`, 302);
    }
    return;
  }

  // 尚未完成 SSO 設定：受保護頁與登入頁都導向 OOBE
  if (oidcStatus.state === "unconfigured") {
    if (isProtectedPage || isLoginPage) {
      return sendRedirect(event, "/setup", 302);
    }
    return;
  }

  const session = secret ? getSessionFromRequest(event.node.req) : null;
  const payload = session ? await parseSessionValue(session, secret) : null;
  const authenticated = Boolean(secret && payload?.email && (await isAllowedEmail(env, payload.email)));

  if (authenticated && (isLoginPage || isSetupPage)) {
    return sendRedirect(event, "/", 302);
  }
  // 已完成設定但未登入：OOBE 精靈已無意義，導回登入頁
  if (isSetupPage) {
    return sendRedirect(event, "/login", 302);
  }
  if (isProtectedPage && !authenticated) {
    return sendRedirect(event, "/login", 302);
  }
});
