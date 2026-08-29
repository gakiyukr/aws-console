// POST /api/setup/start：OOBE「開始 SSO 驗證」。以表單設定產生
// state/nonce/PKCE（設定暫存於簽章 state cookie），回傳 IdP 授權
// URL 供前端導向。完成驗證前設定不落 D1。
import { OidcError } from "../../lib/oidc-error.js";
import { errorResponse, jsonResponse, readJsonBody } from "../../utils/http.js";
import {
  buildCallbackRedirectUri,
  isOidcConfigured,
  probeOidcSetup,
  startLogin,
} from "../../utils/oidc.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  if (await isOidcConfigured(env)) {
    return errorResponse(409, "SSO 已完成設定；如需重新設定，請先清除 D1 內的 sso_config。");
  }
  if (!env?.SESSION_SECRET) {
    return errorResponse(503, "伺服器尚未設定 SESSION_SECRET。");
  }

  const body = await readJsonBody(event);
  if (!body || typeof body !== "object") {
    return errorResponse(400, "請求內容無效。");
  }

  // 先探測 metadata，讓表單錯誤以具體訊息回顯，而非泛用的 configuration
  const probe = await probeOidcSetup(body);
  if (!probe.ok) {
    return errorResponse(400, probe.error);
  }

  try {
    const redirectUri = buildCallbackRedirectUri(getRequestURL(event).origin);
    const { redirectUrl, stateCookie } = await startLogin(env, redirectUri, body);
    setHeader(event, "Set-Cookie", stateCookie);
    return jsonResponse({ redirectUrl });
  } catch (error) {
    if (error instanceof OidcError && error.statusCode === 400) {
      return errorResponse(400, "設定內容無效，請檢查後再試。");
    }
    return errorResponse(502, "無法啟動 SSO 驗證，請稍後再試。");
  }
});
