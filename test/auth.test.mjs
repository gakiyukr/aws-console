// auth.js 的單元測試：session／簽章值的簽驗與時效、cookie 解析與建構、
// 常數時間比較。Node 24 內建 Web Crypto（globalThis.crypto）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SESSION_MAX_AGE_MS,
  buildClearedSessionCookie,
  buildSessionCookie,
  constantTimeCompare,
  createSignedValue,
  getCookieFromRequest,
  getSessionFromRequest,
  parseSessionValue,
  parseSignedValue,
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
  it("建立後可驗證通過並還原 payload", async () => {
    const now = 1_700_000_000_000;
    const value = await createSignedValue({ email: "me@example.com" }, "secret", now);
    const payload = await parseSessionValue(value, "secret", now + HOUR);
    assert.equal(payload.email, "me@example.com");
    assert.equal(Number(payload.issuedAt), now);
  });

  it("錯誤 secret 的簽章無法通過驗證", async () => {
    const now = 1_700_000_000_000;
    const value = await createSignedValue({ email: "me@example.com" }, "secret", now);
    assert.equal(await parseSessionValue(value, "rotated", now), null);
  });

  it("超過 24 小時的 session 失效", async () => {
    const now = 1_700_000_000_000;
    const value = await createSignedValue({ email: "me@example.com" }, "secret", now);
    assert.equal(
      await parseSessionValue(value, "secret", now + SESSION_MAX_AGE_MS + 1),
      null,
    );
    assert.ok(
      await parseSessionValue(value, "secret", now + SESSION_MAX_AGE_MS),
    );
  });

  it("未來時間的 issuedAt 視為無效", async () => {
    const now = 1_700_000_000_000;
    const value = await createSignedValue({ email: "me@example.com" }, "secret", now + 10 * 60 * 1000);
    assert.equal(await parseSessionValue(value, "secret", now), null);
  });

  it("格式不完整的 session 值直接拒絕", async () => {
    assert.equal(await parseSessionValue("", "secret"), null);
    assert.equal(await parseSessionValue("no-signature", "secret"), null);
    assert.equal(await parseSessionValue(null, "secret"), null);
  });

  it("payload 遭竄改後簽章驗證失敗", async () => {
    const now = 1_700_000_000_000;
    const value = await createSignedValue({ email: "me@example.com" }, "secret", now);
    const [, signature] = value.split(".");
    // 以同一 secret 簽署另一 payload，再拼接回原 signature
    const forged = await createSignedValue({ email: "attacker@example.com" }, "secret", now);
    const [forgedPayload] = forged.split(".");
    assert.equal(await parseSessionValue(`${forgedPayload}.${signature}`, "secret", now), null);
  });
});

describe("簽章值（state cookie 共用格式）", () => {
  it("簽章與還原往返一致", async () => {
    const value = await createSignedValue({ state: "s1", verifier: "v1" }, "secret");
    const payload = await parseSignedValue(value, "secret");
    assert.equal(payload.state, "s1");
    assert.equal(payload.verifier, "v1");
  });

  it("parseSignedValue 不檢查時效，交由呼叫端判定", async () => {
    const past = Date.now() - 60 * 60 * 1000;
    const value = await createSignedValue({ state: "s1" }, "secret", past);
    const payload = await parseSignedValue(value, "secret");
    assert.equal(Number(payload.issuedAt), past);
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

describe("cookie 解析與建構", () => {
  it("getSessionFromRequest 解出 URL 編碼的 session 值", () => {
    const request = makeRequest([["ec2_session", "a.b+c/d=e"]]);
    assert.equal(getSessionFromRequest(request), "a.b+c/d=e");
  });

  it("getCookieFromRequest 解出任意名稱的 cookie", () => {
    const request = makeRequest([["ec2_session", "x.y"], ["oidc_state", "state-1"]]);
    assert.equal(getCookieFromRequest(request, "oidc_state"), "state-1");
  });

  it("支援 Nitro 的 Node 型請求標頭物件", () => {
    const request = {
      headers: {
        cookie: "ec2_session=session-1; oidc_state=state-1",
      },
    };
    assert.equal(getSessionFromRequest(request), "session-1");
    assert.equal(getCookieFromRequest(request, "oidc_state"), "state-1");
  });

  it("cookie 缺失時回 null", () => {
    const request = new Request("https://console.example/");
    assert.equal(getSessionFromRequest(request), null);
    assert.equal(getCookieFromRequest(request, "oidc_state"), null);
  });

  it("session cookie 屬性：HttpOnly + Secure + SameSite=Strict + Max-Age 86400", () => {
    const cookie = buildSessionCookie("value");
    assert.ok(cookie.startsWith("ec2_session=value;"));
    assert.ok(cookie.includes("HttpOnly"));
    assert.ok(cookie.includes("Secure"));
    assert.ok(cookie.includes("SameSite=Strict"));
    assert.ok(cookie.includes("Max-Age=86400"));
  });

  it("清除 cookie 的 Max-Age 為 0", () => {
    assert.ok(buildClearedSessionCookie().includes("Max-Age=0"));
  });
});
