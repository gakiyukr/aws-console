// oidc.js 的單元測試：以測試自產的 RSA 金鑰對扮演 IdP（fake fetch 提供
// discovery、jwks 與 token 端點），驗證 startLogin 產生的授權 URL 與
// completeLogin 的 ID token / state / 允許清單檢查。
// 每個案例使用唯一的 issuer 與 jwks_uri，避免 oauth4webapi 的內部
// JWKS 快取（以 Authorization Server 物件為鍵）跨案例污染。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSignedValue } from "../server/utils/auth.js";
import { OidcError } from "../server/lib/oidc-error.js";
import {
  completeLogin,
  getOidcConfig,
  isAllowedEmail,
  isOidcConfigured,
  startLogin,
} from "../server/utils/oidc.js";

const CLIENT_ID = "console-client";
const REDIRECT_URI = "https://console.example/api/auth/callback";
const EMAIL = "me@example.com";

let issuerCounter = 0;

function base64url(text) {
  return Buffer.from(text).toString("base64url");
}

/** 產生測試用 RSA 金鑰對與對應 JWKS 公鑰（含 kid/alg/use 標註）。 */
async function makeSigningKey() {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  return { privateKey, jwk: { ...jwk, kid: "test-key", alg: "RS256", use: "sig" } };
}

/** 以私鑰簽出 ID token。 */
async function makeIdToken(privateKey, claims) {
  const header = base64url(JSON.stringify({ alg: "RS256", kid: "test-key" }));
  const payload = base64url(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(data),
  );
  return `${data}.${base64url(new Uint8Array(signature))}`;
}

function defaultClaims(issuer, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: issuer,
    aud: CLIENT_ID,
    sub: "user-1",
    email: EMAIL,
    nonce: "no-1",
    iat: now,
    exp: now + 300,
    ...overrides,
  };
}

/**
 * 建立隔離的測試環境：唯一 issuer、fake fetch 分派 discovery / jwks /
 * token。idToken 以 signingKey 簽出（tokenKey 可換用其他金鑰模擬錯誤
 * 簽章）；claims 可覆寫以模擬 iss / aud / nonce / email 異常。
 */
async function makeRig(options = {}) {
  const {
    claims: claimsOverride = {},
    tokenKey,
    endpointsExplicit = false,
    allowedEmails = EMAIL,
    issuerOverride,
  } = options;

  const issuer = issuerOverride || `https://idp-${++issuerCounter}.example.com`;
  const signingKey = await makeSigningKey();
  const idToken = await makeIdToken(
    (tokenKey || signingKey).privateKey,
    defaultClaims(issuer, claimsOverride),
  );

  const endpoints = {
    authorization: `${issuer}/authorize`,
    token: `${issuer}/token`,
    jwks: `${issuer}/jwks`,
  };

  const fetchImpl = async (url) => {
    const href = String(url);
    if (!endpointsExplicit && href === `${issuer}/.well-known/openid-configuration`) {
      return Response.json({
        issuer,
        authorization_endpoint: endpoints.authorization,
        token_endpoint: endpoints.token,
        jwks_uri: endpoints.jwks,
      });
    }
    if (href === endpoints.jwks) {
      return Response.json({ keys: [signingKey.jwk] });
    }
    if (href === endpoints.token) {
      return Response.json({ access_token: "access-token", token_type: "Bearer", id_token: idToken });
    }
    throw new Error(`fake fetch 未預期的請求: ${href}`);
  };

  const env = {
    SESSION_SECRET: "session-secret",
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: "client-secret",
    OIDC_ALLOWED_EMAILS: allowedEmails,
    __testHooks: { fetch: fetchImpl },
  };
  if (endpointsExplicit) {
    env.OIDC_AUTHORIZATION_URL = endpoints.authorization;
    env.OIDC_TOKEN_URL = endpoints.token;
    env.OIDC_JWKS_URL = endpoints.jwks;
  }
  return { env, issuer, signingKey };
}

function makeStateValue(overrides = {}, secret = "session-secret") {
  return createSignedValue({ state: "st-1", nonce: "no-1", verifier: "pkce-verifier", ...overrides }, secret);
}

const CALLBACK_QUERY = { code: "auth-code", state: "st-1" };

describe("getOidcConfig", () => {
  it("設定齊全時回傳正規化設定（email 轉小寫）", () => {
    const env = {
      OIDC_ISSUER: "https://idp.example.com",
      OIDC_CLIENT_ID: CLIENT_ID,
      OIDC_CLIENT_SECRET: "s",
      OIDC_ALLOWED_EMAILS: ` ME@Example.com , other@example.com `,
    };
    const config = getOidcConfig(env);
    assert.deepEqual(config.allowedEmails, ["me@example.com", "other@example.com"]);
    assert.ok(isOidcConfigured(env));
    assert.ok(isAllowedEmail(env, "Me@Example.COM"));
  });

  it("缺任一必填項時回 null 且視為未設定", () => {
    const env = {
      OIDC_ISSUER: "https://idp.example.com",
      OIDC_CLIENT_ID: CLIENT_ID,
      OIDC_CLIENT_SECRET: "s",
      OIDC_ALLOWED_EMAILS: "",
    };
    assert.equal(getOidcConfig(env), null);
    assert.equal(isOidcConfigured(env), false);
    assert.equal(isAllowedEmail(env, EMAIL), false);
  });
});

describe("startLogin", () => {
  it("產生含 PKCE 與 state/nonce 的授權 URL 與 state cookie", async () => {
    const { env } = await makeRig();
    const { redirectUrl, stateCookie } = await startLogin(env, REDIRECT_URI);

    const url = new URL(redirectUrl);
    assert.ok(url.pathname.endsWith("/authorize"));
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
    assert.equal(url.searchParams.get("scope"), "openid email profile");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.ok(url.searchParams.get("code_challenge"));
    assert.ok(url.searchParams.get("state"));
    assert.ok(url.searchParams.get("nonce"));

    assert.ok(stateCookie.startsWith("oidc_state="));
    assert.ok(stateCookie.includes("HttpOnly"));
    assert.ok(stateCookie.includes("Max-Age=600"));
  });

  it("三端點齊備時不進行 discovery，直接使用明確端點", async () => {
    const { env, issuer } = await makeRig({ endpointsExplicit: true });
    const { redirectUrl } = await startLogin(env, REDIRECT_URI);
    assert.ok(redirectUrl.startsWith(`${issuer}/authorize`));
  });
});

describe("completeLogin", () => {
  it("正常流程回傳允許清單內的 email", async () => {
    const { env } = await makeRig();
    const { email } = await completeLogin(env, REDIRECT_URI, CALLBACK_QUERY, await makeStateValue());
    assert.equal(email, EMAIL);
  });

  it("支援 IdP 無 discovery 時以明確端點完成流程", async () => {
    const { env } = await makeRig({ endpointsExplicit: true });
    const { email } = await completeLogin(env, REDIRECT_URI, CALLBACK_QUERY, await makeStateValue());
    assert.equal(email, EMAIL);
  });

  it("state cookie 缺失或簽章不符時回 state_mismatch", async () => {
    const { env } = await makeRig();

    await assert.rejects(
      completeLogin(env, REDIRECT_URI, CALLBACK_QUERY, null),
      (error) => error instanceof OidcError && error.code === "state_mismatch",
    );
    await assert.rejects(
      completeLogin(env, REDIRECT_URI, CALLBACK_QUERY, await makeStateValue({}, "wrong-secret")),
      (error) => error instanceof OidcError && error.code === "state_mismatch",
    );
  });

  it("query 的 state 與 cookie 不符時拒絕（verification_failed）", async () => {
    const { env } = await makeRig();

    await assert.rejects(
      completeLogin(env, REDIRECT_URI, { code: "auth-code", state: "st-2" }, await makeStateValue()),
      (error) => error instanceof OidcError && error.code === "verification_failed",
    );
  });

  it("IdP 回傳 error 參數時回報 idp_error", async () => {
    const { env } = await makeRig();
    await assert.rejects(
      completeLogin(env, REDIRECT_URI, { error: "access_denied" }, await makeStateValue()),
      (error) => error instanceof OidcError && error.code === "idp_error",
    );
  });

  it("ID token nonce 不符時拒絕", async () => {
    const { env } = await makeRig({ claims: { nonce: "no-2" } });

    await assert.rejects(
      completeLogin(env, REDIRECT_URI, CALLBACK_QUERY, await makeStateValue()),
      (error) => error instanceof OidcError && error.code === "verification_failed",
    );
  });

  it("ID token 過期時拒絕", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { env } = await makeRig({ claims: { nonce: "no-1", iat: now - 3600, exp: now - 1800 } });

    await assert.rejects(
      completeLogin(env, REDIRECT_URI, CALLBACK_QUERY, await makeStateValue()),
      (error) => error instanceof OidcError && error.code === "verification_failed",
    );
  });

  it("ID token 簽章錯誤（金鑰不符）時拒絕", async () => {
    const attackerKey = await makeSigningKey();
    const { env } = await makeRig({ tokenKey: attackerKey });

    await assert.rejects(
      completeLogin(env, REDIRECT_URI, CALLBACK_QUERY, await makeStateValue()),
      (error) => error instanceof OidcError && error.code === "verification_failed",
    );
  });

  it("iss 或 aud 不符時拒絕", async () => {
    for (const claims of [
      { iss: "https://evil.example.com" },
      { aud: "another-client" },
    ]) {
      const { env } = await makeRig({ claims: { nonce: "no-1", ...claims } });
      await assert.rejects(
        completeLogin(env, REDIRECT_URI, CALLBACK_QUERY, await makeStateValue()),
        (error) => error instanceof OidcError && error.code === "verification_failed",
      );
    }
  });

  it("email 不在允許清單時回 email_not_allowed", async () => {
    const { env } = await makeRig({ claims: { email: "stranger@example.com" } });

    await assert.rejects(
      completeLogin(env, REDIRECT_URI, CALLBACK_QUERY, await makeStateValue()),
      (error) => error instanceof OidcError && error.code === "email_not_allowed",
    );
  });

  it("state cookie 逾時（超過 10 分鐘）時回 state_mismatch", async () => {
    const { env } = await makeRig();
    const stateValue = await createSignedValue(
      { state: "st-1", nonce: "no-1", verifier: "pkce-verifier" },
      "session-secret",
      Date.now() - 11 * 60 * 1000,
    );

    await assert.rejects(
      completeLogin(env, REDIRECT_URI, CALLBACK_QUERY, stateValue),
      (error) => error instanceof OidcError && error.code === "state_mismatch",
    );
  });
});
