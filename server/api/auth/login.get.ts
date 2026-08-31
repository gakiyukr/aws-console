// GET /api/auth/login：SSO 登入入口。已登入直接回主控台；否則產生
// state/nonce/PKCE verifier（簽章後存入短效 HttpOnly cookie），
// 302 導向 IdP 授權端點。設定缺失時導回 /login 並帶錯誤代碼。
import { OidcError } from "../../lib/oidc-error.js";
import { OidcConfigurationError } from "../../lib/oidc-configuration-error.js";
import {
  getSessionFromRequest,
  parseSessionValue,
} from "../../utils/auth.js";
import {
  buildCallbackRedirectUri,
  getOidcConfigurationStatus,
  startLogin,
} from "../../utils/oidc.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  const secret = env?.SESSION_SECRET;

  const session = secret ? getSessionFromRequest(event.node.req) : null;
  const payload = session ? await parseSessionValue(session, secret) : null;
  if (payload?.email) {
    return sendRedirect(event, "/", 302);
  }

  try {
    const redirectUri = buildCallbackRedirectUri(getRequestURL(event).origin);
    const { redirectUrl, stateCookie } = await startLogin(env, redirectUri);
    setHeader(event, "Set-Cookie", stateCookie);
    return sendRedirect(event, redirectUrl, 302);
  } catch (error) {
    if (error instanceof OidcConfigurationError) {
      return sendRedirect(event, `/503?reason=${encodeURIComponent(error.reason)}`, 302);
    }
    const oidcStatus = await getOidcConfigurationStatus(env);
    if (oidcStatus.state === "error" || !secret) {
      const reason = oidcStatus.state === "error" ? oidcStatus.reason : "session_secret_missing";
      return sendRedirect(event, `/503?reason=${encodeURIComponent(reason)}`, 302);
    }
    if (oidcStatus.state === "unconfigured") {
      return sendRedirect(event, "/setup", 302);
    }
    const code = error instanceof OidcError ? error.code : "configuration";
    return sendRedirect(event, `/login?error=${encodeURIComponent(code)}`, 302);
  }
});
