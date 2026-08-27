// auth.js 的單元測試：session 簽驗、時效、密碼雜湊綁定、CSRF、
// 常數時間比較。Node 24 內建 Web Crypto（globalThis.crypto）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SESSION_MAX_AGE_MS,
  buildClearedCsrfCookie,
  buildClearedSessionCookie,
  buildCsrfCookie,
  buildSessionCookie,
  constantTimeCompare,
  createSessionValue,
  generateCsrfToken,
  getCsrfTokenFromRequest,
  getSessionFromRequest,
  verifySessionValue,
} from "../server/utils/auth.js";

const HOUR = 60 * 60 * 1000;

function makeRequest(cookiePairs) {
  const cookieHeader = cookiePairs
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");
  return new Request("https://console.example/api/session", {
    headers: { cookie: cookieHeader },
  });
}

describe("session 簽章與驗證", () => {
  it("建立後可驗證通過", async () => {
    const now = 1_700_000_000_000;
    const value = await createSessionValue("pw123", "secret", now);
    assert.ok(await verifySessionValue(value, "secret", "pw123", now + HOUR));
  });

  it("錯誤密碼的 session 無法通過驗證", async () => {
    const now = 1_700_000_000_000;
    const value = await createSessionValue("pw123", "secret", now);
    assert.equal(await verifySessionValue(value, "secret", "other", now), false);
  });

  it("錯誤 secret 的簽章無法通過驗證", async () => {
    const now = 1_700_000_000_000;
    const value = await createSessionValue("pw123", "secret", now);
    assert.equal(await verifySessionValue(value, "rotated", "pw123", now), false);
  });

  it("超過 24 小時的 session 失效", async () => {
    const now = 1_700_000_000_000;
    const value = await createSessionValue("pw123", "secret", now);
    assert.equal(
      await verifySessionValue(value, "secret", "pw123", now + SESSION_MAX_AGE_MS + 1),
      false,
    );
    assert.equal(
      await verifySessionValue(value, "secret", "pw123", now + SESSION_MAX_AGE_MS),
      true,
    );
  });

  it("更換密碼後既有 session 立即失效（passwordHash 綁定）", async () => {
    const now = 1_700_000_000_000;
    const value = await createSessionValue("old-pw", "secret", now);
    assert.equal(await verifySessionValue(value, "secret", "new-pw", now + 1000), false);
  });

  it("未來時間的 issuedAt 視為無效", async () => {
    const now = 1_700_000_000_000;
    const value = await createSessionValue("pw123", "secret", now + 10 * MINUTE_SAFE());
    assert.equal(await verifySessionValue(value, "secret", "pw123", now), false);
  });

  function MINUTE_SAFE() {
    return 60 * 1000;
  }

  it("格式不完整的 session 值直接拒絕", async () => {
    const now = 1_700_000_000_000;
    assert.equal(await verifySessionValue("", "secret", "pw123", now), false);
    assert.equal(await verifySessionValue("no-signature", "secret", "pw123", now), false);
    assert.equal(await verifySessionValue(null, "secret", "pw123", now), false);
  });

  it("payload 遭竄改後簽章驗證失敗", async () => {
    const now = 1_700_000_000_000;
    const value = await createSessionValue("pw123", "secret", now);
    const [payload, signature] = value.split(".");
    // 以同一 secret 簽署另一 payload，再拼接回原 signature
    const forged = await createSessionValue("pw456", "secret", now);
    const [forgedPayload] = forged.split(".");
    assert.equal(await verifySessionValue(`${forgedPayload}.${signature}`, "secret", "pw123", now), false);
    assert.notEqual(payload, forgedPayload);
  });
});

describe("constantTimeCompare", () => {
  it("相同內容回 true，不同內容回 false", async () => {
    assert.equal(await constantTimeCompare("abc", "abc"), true);
    assert.equal(await constantTimeCompare("abc", "abd"), false);
  });

  it("長度不同直接回 false", async () => {
    assert.equal(await constantTimeCompare("abc", "abcd"), false);
  });
});

describe("CSRF token", () => {
  it("每次產生的 token 皆為 64 字元 hex 且不重複", () => {
    const a = generateCsrfToken();
    const b = generateCsrfToken();
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, b);
  });
});

describe("cookie 解析與建構", () => {
  it("getSessionFromRequest 解出 URL 編碼的 session 值", () => {
    const request = makeRequest([["ec2_session", "a.b+c/d=e"]]);
    assert.equal(getSessionFromRequest(request), "a.b+c/d=e");
  });

  it("getCsrfTokenFromRequest 解出 csrf cookie", () => {
    const request = makeRequest([["ec2_session", "x.y"], ["ec2_csrf", "token-1"]]);
    assert.equal(getCsrfTokenFromRequest(request), "token-1");
  });

  it("cookie 缺失時回 null", () => {
    const request = new Request("https://console.example/");
    assert.equal(getSessionFromRequest(request), null);
    assert.equal(getCsrfTokenFromRequest(request), null);
  });

  it("session cookie 屬性：HttpOnly + Secure + SameSite=Strict + Max-Age 86400", () => {
    const cookie = buildSessionCookie("value");
    assert.ok(cookie.startsWith("ec2_session=value;"));
    assert.ok(cookie.includes("HttpOnly"));
    assert.ok(cookie.includes("Secure"));
    assert.ok(cookie.includes("SameSite=Strict"));
    assert.ok(cookie.includes("Max-Age=86400"));
  });

  it("csrf cookie 不含 HttpOnly（前端需讀取）", () => {
    const cookie = buildCsrfCookie("token");
    assert.ok(cookie.includes("ec2_csrf=token"));
    assert.ok(!cookie.includes("HttpOnly"));
  });

  it("清除 cookie 的 Max-Age 為 0", () => {
    assert.ok(buildClearedSessionCookie().includes("Max-Age=0"));
    assert.ok(buildClearedCsrfCookie().includes("Max-Age=0"));
  });
});
