// 認證工具：session 簽章／驗證、CSRF token、常數時間比較。
// 移植自 wavelength 主控台（含 passwordHash 機制——改密碼即全數
// session 失效），session 時長採電源主控台的 24 小時。
// 全函式為純模組，依賴僅 Web Crypto，node --test 可直接驗證。
import { getHeaderValue } from "./http.js";

export const SESSION_COOKIE = "ec2_session";
export const CSRF_COOKIE = "ec2_csrf";
export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function toBase64Url(text) {
  return bytesToBase64(new TextEncoder().encode(text))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function fromBase64Url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4 || 4)) % 4;
  return new TextDecoder().decode(base64ToBytes(padded + "=".repeat(padLength)));
}

async function signText(text, secret) {
  const data = new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    data,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(text),
  );
  return bytesToBase64(new Uint8Array(signature))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sha256Base64Url(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return bytesToBase64(new Uint8Array(digest))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** 常數時間比較：長度不同直接回 false，其餘逐位元 XOR 累積後一次判定。 */
export async function constantTimeCompare(a, b) {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);

  if (aBytes.length !== bBytes.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }
  return result === 0;
}

/**
 * 建立 session 值。正式登入傳入 userId 與 authVersion；字串輸入只保留
 * 給舊版純函式呼叫相容。兩種 payload 都以 SESSION_SECRET 簽章。
 */
export async function createSessionValue(password, secret, now = Date.now()) {
  if (password && typeof password === "object") {
    const payload = toBase64Url(JSON.stringify({
      userId: Number(password.userId),
      authVersion: Number(password.authVersion),
      issuedAt: now,
    }));
    return `${payload}.${await signText(payload, secret)}`;
  }
  const payload = toBase64Url(
    JSON.stringify({
      passwordHash: await sha256Base64Url(password),
      issuedAt: now,
    }),
  );
  const signature = await signText(payload, secret);
  return `${payload}.${signature}`;
}

/** 驗證簽章與時效後讀取 session payload；不在此層查詢 D1。 */
export async function parseSessionValue(sessionValue, secret, now = Date.now()) {
  if (!sessionValue || !sessionValue.includes(".") || !secret)
    return null;
  const [payload, signature] = sessionValue.split(".", 2);
  if (!(await constantTimeCompare(signature, await signText(payload, secret))))
    return null;
  try {
    const parsed = JSON.parse(fromBase64Url(payload));
    const issuedAt = Number(parsed.issuedAt);
    const ageMs = now - issuedAt;
    if (!Number.isFinite(issuedAt) || ageMs < 0 || ageMs > SESSION_MAX_AGE_MS)
      return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 驗證 session 值：簽章比對（字串比較前先經 constantTimeCompare 的
 * 等長檢查由 HMAC 輸出等長保證）、密碼雜湊與時效（24 小時）皆須通過。
 */
export async function verifySessionValue(sessionValue, secret, expectedPassword, now = Date.now()) {
  if (!sessionValue || !sessionValue.includes(".")) {
    return false;
  }

  const [payload, signature] = sessionValue.split(".", 2);
  const expectedSignature = await signText(payload, secret);
  if (!(await constantTimeCompare(signature, expectedSignature))) {
    return false;
  }

  try {
    const parsed = JSON.parse(fromBase64Url(payload));
    const issuedAt = Number(parsed.issuedAt);
    const expectedPasswordHash = await sha256Base64Url(expectedPassword);
    if (!Number.isFinite(issuedAt)) {
      return false;
    }
    const ageMs = now - issuedAt;
    return (
      parsed.passwordHash === expectedPasswordHash &&
      ageMs >= 0 &&
      ageMs <= SESSION_MAX_AGE_MS
    );
  } catch {
    return false;
  }
}

/** 自 Cookie 標頭解析指定名稱的值（decodeURIComponent 還原簽章內的特殊字元）。 */
function getCookieValue(request, name) {
  const cookieHeader = getHeaderValue(request?.headers, "cookie");
  const cookies = cookieHeader.split(/;\s*/).filter(Boolean);
  for (const cookie of cookies) {
    const [key, ...rest] = cookie.split("=");
    if (key === name) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return null;
}

export function getSessionFromRequest(request) {
  return getCookieValue(request, SESSION_COOKIE);
}

export function getCsrfTokenFromRequest(request) {
  return getCookieValue(request, CSRF_COOKIE);
}

/** 產生 32 位元組隨機 hex token 作為 CSRF token。 */
export function generateCsrfToken() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function buildSessionCookie(sessionValue) {
  return `${SESSION_COOKIE}=${encodeURIComponent(sessionValue)}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${SESSION_MAX_AGE_MS / 1000}`;
}

// CSRF cookie 可被前端 JS 讀取（雙送出模式），故不加 HttpOnly
export function buildCsrfCookie(csrfToken) {
  return `${CSRF_COOKIE}=${encodeURIComponent(csrfToken)}; Path=/; SameSite=Strict; Secure; Max-Age=${SESSION_MAX_AGE_MS / 1000}`;
}

export function buildClearedSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0`;
}

export function buildClearedCsrfCookie() {
  return `${CSRF_COOKIE}=; Path=/; SameSite=Strict; Secure; Max-Age=0`;
}
