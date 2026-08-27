// HTTP 標頭相容性測試：Workers Headers 與 Nitro Node 型物件都必須可解析。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getClientIp, getHeaderValue, readJsonBody } from "../server/utils/http.js";

describe("HTTP 標頭相容性", () => {
  it("支援 Workers Headers", () => {
    const headers = new Headers({ "cf-connecting-ip": "203.0.113.1" });
    assert.equal(getHeaderValue(headers, "cf-connecting-ip"), "203.0.113.1");
    assert.equal(getClientIp(headers), "203.0.113.1");
  });

  it("支援 Nitro Node 型標頭物件與轉送 IP", () => {
    const headers = {
      "x-forwarded-for": "198.51.100.7, 10.0.0.1",
      "x-real-ip": "198.51.100.8",
    };
    assert.equal(getHeaderValue(headers, "x-real-ip"), "198.51.100.8");
    assert.equal(getClientIp(headers), "198.51.100.7");
  });
});

describe("JSON 請求內容解析", () => {
  it("支援 Fetch Request", async () => {
    const request = new Request("https://console.example/api/login", {
      method: "POST",
      body: JSON.stringify({ password: "example-password" }),
      headers: { "content-type": "application/json" },
    });
    assert.deepEqual(await readJsonBody(request), { password: "example-password" });
  });

  it("格式錯誤時回傳 null", async () => {
    const request = new Request("https://console.example/api/login", {
      method: "POST",
      body: "{invalid-json",
      headers: { "content-type": "application/json" },
    });
    assert.equal(await readJsonBody(request), null);
  });
});
