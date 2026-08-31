// GET /api/auth/callback：IdP 授權碼回調。驗 state、交換授權碼並驗證
// ID token，email 在允許清單中即簽發 session 並導回主控台；任何失敗
// 導回 /login?error=<代碼>（統一不透露驗證細節）。
// OOBE 流程：state cookie 內帶有暫存設定時，驗證通過且 email 與
// 綁定 email 一致，才將設定寫入 D1 並導向主控台；失敗導回 /setup
// （尚未設定 SSO 時的失敗一定屬於 OOBE 流程）。
import { OidcError } from "../../lib/oidc-error.js";
import { OidcConfigurationError } from "../../lib/oidc-configuration-error.js";
import { saveSsoConfig } from "../../utils/db.js";
import {
  buildSessionCookie,
  createSignedValue,
  getCookieFromRequest,
} from "../../utils/auth.js";
import {
  buildCallbackRedirectUri,
  buildClearedStateCookie,
  clearSsoConfigCache,
  completeLogin,
  getOidcConfigurationStatus,
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
    const { email, setup } = await completeLogin(env, redirectUri, query, stateValue);

    if (setup) {
      // OOBE：驗證通過才落 D1；client secret 加密儲存
      try {
        await saveSsoConfig(env.DB, {
          issuer: setup.issuer,
          authorizationEndpoint: setup.authorizationUrl,
          tokenEndpoint: setup.tokenUrl,
          jwksUri: setup.jwksUrl,
          clientId: setup.clientId,
          clientSecret: setup.clientSecret,
          allowedEmail: setup.email,
        }, env.CREDENTIAL_ENCRYPTION_KEY);
        clearSsoConfigCache();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new OidcConfigurationError(
          message.includes("no such table")
            ? "sso_schema_missing"
            : "sso_config_save_failed",
        );
      }
    }

    const sessionValue = await createSignedValue({ email }, secret);
    setHeader(event, "Set-Cookie", [
      buildSessionCookie(sessionValue),
      buildClearedStateCookie(),
    ]);
    return sendRedirect(event, "/", 302);
  } catch (error) {
    setHeader(event, "Set-Cookie", buildClearedStateCookie());
    if (error instanceof OidcConfigurationError) {
      return sendRedirect(event, `/503?reason=${encodeURIComponent(error.reason)}`, 302);
    }

    const oidcStatus = await getOidcConfigurationStatus(env);
    if (oidcStatus.state === "error" || !secret) {
      const reason = oidcStatus.state === "error" ? oidcStatus.reason : "session_secret_missing";
      return sendRedirect(event, `/503?reason=${encodeURIComponent(reason)}`, 302);
    }

    const code = error instanceof OidcError ? error.code : "verification_failed";
    const target = oidcStatus.state === "unconfigured" ? "/setup" : "/login";
    return sendRedirect(event, `${target}?error=${encodeURIComponent(code)}`, 302);
  }
});
