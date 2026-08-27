// POST /api/login：CSRF 驗證 → D1 限流檢查 → 常數時間密碼比較。
// 成功：簽發 ec2_session cookie（24 小時）並清除該 IP 失敗計數；
// 失敗：記錄失敗（原子 upsert），達 5 次即封鎖 15 分鐘（回 429）。
import {
  buildClearedCsrfCookie,
  buildSessionCookie,
  constantTimeCompare,
  createSessionValue,
  getCsrfTokenFromRequest,
} from "../utils/auth.js";
import { getClientIp, jsonResponse, readJsonBody } from "../utils/http.js";
import {
  isLoginBlocked,
  registerLoginFailure,
  resetLoginFailures,
} from "../utils/rate-limit.js";

// CSRF 比對用的標頭名稱：前端從 ec2_csrf cookie 讀值後放入此標頭
const CSRF_HEADER = "x-csrf-token";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  const password = env?.APP_PASSWORD;
  const secret = env?.SESSION_SECRET;
  const db = env?.DB;

  if (!password || !secret || !db) {
    throw createError({
      statusCode: 503,
      message: "伺服器尚未完成認證設定",
    });
  }

  // ── CSRF 驗證：cookie 與 header 皆須存在且一致（雙送出模式）──
  const cookieToken = getCsrfTokenFromRequest(event.node.req);
  const headerToken = getHeader(event, CSRF_HEADER);
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    throw createError({
      statusCode: 403,
      message: "CSRF 驗證失敗",
      data: { error: "CSRF 驗證失敗" },
    });
  }

  const body = await readJsonBody(event);
  const submittedPassword = typeof body?.password === "string" ? body.password : "";
  const clientIp = getClientIp(event.node.req.headers);

  // ── 限流：封鎖期間一律 429，不洩漏密碼是否正確 ──
  const blockState = await isLoginBlocked(db, clientIp);
  if (blockState.blocked) {
    throw createError({
      statusCode: 429,
      message: "嘗試次數過多，請稍後再試",
      data: { error: "嘗試次數過多，請稍後再試", retryAfterMs: blockState.retryAfterMs },
    });
  }

  // ── 密碼比較：常數時間，避免時序側通道 ──
  const passwordOk = submittedPassword
    && (await constantTimeCompare(submittedPassword, password));

  if (!passwordOk) {
    await registerLoginFailure(db, clientIp);
    throw createError({
      statusCode: 401,
      message: "密碼錯誤",
      data: { error: "密碼錯誤" },
    });
  }

  // ── 登入成功：簽發 session、清除失敗計數、清除 CSRF cookie 使其單次有效 ──
  await resetLoginFailures(db, clientIp);
  const sessionValue = await createSessionValue(password, secret);
  setHeader(event, "Set-Cookie", [buildSessionCookie(sessionValue), buildClearedCsrfCookie()]);
  return jsonResponse({ ok: true });
});
