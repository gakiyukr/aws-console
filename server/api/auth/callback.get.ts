// GET /api/auth/callback：IdP 授權碼回調。驗 state、交換授權碼並驗證
// ID token，email 在允許清單中即簽發 session 並導回主控台；任何失敗
// 導回 /login?error=<代碼>（統一不透露驗證細節）。
import { OidcError } from "../../lib/oidc-error.js";
import {
  buildSessionCookie,
  createSignedValue,
  getCookieFromRequest,
} from "../../utils/auth.js";
import {
  buildCallbackRedirectUri,
  buildClearedStateCookie,
  completeLogin,
  STATE_COOKIE,
} from "../../utils/oidc.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  const secret = env?.SESSION_SECRET;
  const query = getQuery(event);

  try {
    if (!secret) {
      throw new OidcError("configuration", 503);
    }
    const redirectUri = buildCallbackRedirectUri(getRequestURL(event).origin);
    const stateValue = getCookieFromRequest(event.node.req, STATE_COOKIE);
    const { email } = await completeLogin(env, redirectUri, query, stateValue);

    const sessionValue = await createSignedValue({ email }, secret);
    setHeader(event, "Set-Cookie", [
      buildSessionCookie(sessionValue),
      buildClearedStateCookie(),
    ]);
    return sendRedirect(event, "/", 302);
  } catch (error) {
    const code = error instanceof OidcError ? error.code : "verification_failed";
    setHeader(event, "Set-Cookie", buildClearedStateCookie());
    return sendRedirect(event, `/login?error=${encodeURIComponent(code)}`, 302);
  }
});
