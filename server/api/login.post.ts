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
import { createUser, getUserByUsername, listUsers } from "../utils/db.js";
import { getClientIp, jsonResponse, readJsonBody } from "../utils/http.js";
import { hashPassword, verifyPassword } from "../utils/password.js";
import {
  isLoginBlocked,
  registerLoginFailure,
  resetLoginFailures,
} from "../utils/rate-limit.js";

// CSRF 比對用的標頭名稱：前端從 ec2_csrf cookie 讀值後放入此標頭
const CSRF_HEADER = "x-csrf-token";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  const bootstrapPassword = env?.APP_PASSWORD;
  const secret = env?.SESSION_SECRET;
  const db = env?.DB;

  if (!secret || !db) {
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
  const username = typeof body?.username === "string" ? body.username.trim() : "admin";
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

  let user = await getUserByUsername(db, username);
  const users = user ? null : await listUsers(db);

  // 尚無使用者時，以 APP_PASSWORD 完成一次性管理者引導並立即寫入 D1。
  if (!user && users?.length === 0 && bootstrapPassword && username === "admin") {
    const bootstrapOk = submittedPassword
      && await constantTimeCompare(submittedPassword, bootstrapPassword);
    if (bootstrapOk) {
      user = await createUser(db, {
        username: "admin",
        ...await hashPassword(submittedPassword),
        role: "admin",
        enabled: true,
      });
    }
  }

  const passwordOk = Boolean(
    user?.enabled && submittedPassword && await verifyPassword(submittedPassword, user),
  );

  if (!passwordOk) {
    await registerLoginFailure(db, clientIp);
    throw createError({
      statusCode: 401,
      message: "帳號或密碼錯誤",
      data: { error: "帳號或密碼錯誤" },
    });
  }

  // ── 登入成功：簽發 session、清除失敗計數、清除 CSRF cookie 使其單次有效 ──
  await resetLoginFailures(db, clientIp);
  const sessionValue = await createSessionValue({ userId: user.id, authVersion: user.authVersion }, secret);
  setHeader(event, "Set-Cookie", [buildSessionCookie(sessionValue), buildClearedCsrfCookie()]);
  return jsonResponse({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
});
