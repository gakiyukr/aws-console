// OIDC SSO 登入流程：協議細節（discovery、PKCE、授權碼交換、ID token
// 簽章與 claims 驗證）交由 oauth4webapi（純 Web Crypto，Workers 與
// node --test 相容），本模組只負責組合流程、email 允許清單比對與
// 測試用的 fetch 注入（env.__testHooks.fetch）。
import * as oauth from "oauth4webapi";
import { OidcError } from "../lib/oidc-error.js";
import { createSignedValue, parseSignedValue } from "./auth.js";

// state cookie 名稱；授權碼流程應在數分鐘內完成，逾時即作廢
export const STATE_COOKIE = "oidc_state";
const STATE_MAX_AGE_S = 600;
const SCOPE = "openid email profile";

// discovery 結果以 isolate 記憶體快取，避免每次登入都向 IdP 取 metadata
const DISCOVERY_TTL_MS = 600_000;
const discoveryCache = { key: "", as: null, fetchedAt: 0 };

/** 組出 IdP callback 的 redirect URI。 */
export function buildCallbackRedirectUri(origin) {
  return new URL("/api/auth/callback", origin).href;
}

/**
 * 讀取並驗證 OIDC 環境變數；缺任一必填項回 null，由呼叫端 fail closed。
 */
export function getOidcConfig(env) {
  const issuer = env?.OIDC_ISSUER;
  const clientId = env?.OIDC_CLIENT_ID;
  const clientSecret = env?.OIDC_CLIENT_SECRET;
  const allowedEmails = String(env?.OIDC_ALLOWED_EMAILS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!issuer || !clientId || !clientSecret || allowedEmails.length === 0) {
    return null;
  }
  return {
    // issuer 保留原始字串：ID token 的 iss 比對是精確字串比對，
    // 經 new URL().href 正規化可能補上尾斜線而導致不符
    issuer,
    issuerUrl: new URL(issuer),
    clientId,
    clientSecret,
    allowedEmails,
    // IdP 未提供 discovery 時，可改以三個明確端點組出 metadata
    authorizationEndpoint: env?.OIDC_AUTHORIZATION_URL || "",
    tokenEndpoint: env?.OIDC_TOKEN_URL || "",
    jwksUri: env?.OIDC_JWKS_URL || "",
  };
}

/** 部署環境是否完成 OIDC 設定（middleware 與登入路由共用）。 */
export function isOidcConfigured(env) {
  return getOidcConfig(env) !== null;
}

/** session 內 email 是否在允許清單中。 */
export function isAllowedEmail(env, email) {
  const config = getOidcConfig(env);
  return Boolean(config && config.allowedEmails.includes(String(email).toLowerCase()));
}

// 解析 Authorization Server metadata：三端點齊備時直接組出，否則走 discovery。
async function resolveAuthorizationServer(config, fetchImpl) {
  const cacheKey = `${config.issuer}|${config.authorizationEndpoint}`;
  const now = Date.now();
  if (
    discoveryCache.key === cacheKey
    && discoveryCache.as
    && now - discoveryCache.fetchedAt < DISCOVERY_TTL_MS
  ) {
    return discoveryCache.as;
  }

  let as;
  if (config.authorizationEndpoint && config.tokenEndpoint && config.jwksUri) {
    as = {
      issuer: config.issuer,
      authorization_endpoint: config.authorizationEndpoint,
      token_endpoint: config.tokenEndpoint,
      jwks_uri: config.jwksUri,
    };
  } else {
    as = await oauth.processDiscoveryResponse(
      config.issuerUrl,
      await oauth.discoveryRequest(config.issuerUrl, { [oauth.customFetch]: fetchImpl }),
    );
  }
  discoveryCache.key = cacheKey;
  discoveryCache.as = as;
  discoveryCache.fetchedAt = now;
  return as;
}

/**
 * 產生登入導向 URL 與 state cookie。
 * state/nonce/PKCE verifier 以 SESSION_SECRET 簽章存入短效 HttpOnly
 * cookie，callback 時比對 cookie 與 query，防偽造與 CSRF。
 */
export async function startLogin(env, redirectUri) {
  const config = getOidcConfig(env);
  if (!config || !env?.SESSION_SECRET) {
    throw new OidcError("configuration", 503);
  }
  const fetchImpl = env.__testHooks?.fetch || fetch;
  const as = await resolveAuthorizationServer(config, fetchImpl);

  const state = oauth.generateRandomState();
  const nonce = oauth.generateRandomNonce();
  const verifier = oauth.generateRandomCodeVerifier();
  const challenge = await oauth.calculatePKCECodeChallenge(verifier);

  const url = new URL(as.authorization_endpoint);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })) {
    url.searchParams.set(key, value);
  }

  const stateValue = await createSignedValue({ state, nonce, verifier }, env.SESSION_SECRET);
  return {
    redirectUrl: url.href,
    stateCookie:
      `${STATE_COOKIE}=${encodeURIComponent(stateValue)}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${STATE_MAX_AGE_S}`,
  };
}

/** 清除 state cookie 的 Set-Cookie 標頭。 */
export function buildClearedStateCookie() {
  return `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0`;
}

/**
 * 處理 IdP callback：驗 state、交換授權碼並驗證 ID token（簽章、
 * iss/aud/exp 由 oauth4webapi 依 metadata 檢查、nonce 於此處傳入），
 * 最後比對 email 允許清單。成功回傳登入者 email。
 */
export async function completeLogin(env, redirectUri, query, stateValue) {
  const config = getOidcConfig(env);
  if (!config || !env?.SESSION_SECRET) {
    throw new OidcError("configuration", 503);
  }
  const fetchImpl = env.__testHooks?.fetch || fetch;
  const as = await resolveAuthorizationServer(config, fetchImpl);

  const stored = await parseSignedValue(stateValue, env.SESSION_SECRET);
  if (
    !stored?.state
    || !stored?.nonce
    || !stored?.verifier
    || Date.now() - Number(stored.issuedAt) > STATE_MAX_AGE_S * 1000
  ) {
    throw new OidcError("state_mismatch");
  }

  const callbackParams = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") {
      callbackParams.set(key, value);
    }
  }
  // IdP 端拒絕（使用者取消、政策不符等）回 error 參數而非授權碼
  if (callbackParams.get("error")) {
    throw new OidcError("idp_error");
  }

  const client = { client_id: config.clientId };
  // JWKS 快取以每次登入為週期：IdP 輪換金鑰時不會被 isolate 內的
  // 舊快取卡住，單次登入的代價只是多一次 GET。
  const jwksCache = {};
  let tokens;
  try {
    const params = oauth.validateAuthResponse(as, client, callbackParams, stored.state);
    const response = await oauth.authorizationCodeGrantRequest(
      as,
      client,
      oauth.ClientSecretBasic(config.clientSecret),
      params,
      redirectUri,
      stored.verifier,
      { [oauth.customFetch]: fetchImpl },
    );
    tokens = await oauth.processAuthorizationCodeResponse(as, client, response, {
      expectedNonce: stored.nonce,
      requireIdToken: true,
      [oauth.customFetch]: fetchImpl,
    });
    // oauth4webapi 依 OIDC 規範視「TLS 即身分驗證」，token 回應中的
    // ID token 簽章不在此預設檢查；本主控台以 JWKS 額外驗章。
    await oauth.validateApplicationLevelSignature(as, response, {
      [oauth.customFetch]: fetchImpl,
      [oauth.jwksCache]: jwksCache,
    });
  } catch {
    // state 不符、授權碼無效或 ID token 驗證失敗，一律不對外透露細節
    throw new OidcError("verification_failed", 401);
  }

  const claims = oauth.getValidatedIdTokenClaims(tokens);
  const email = String(claims?.email || "").toLowerCase();
  if (!email || !config.allowedEmails.includes(email)) {
    throw new OidcError("email_not_allowed", 403);
  }
  return { email };
}
