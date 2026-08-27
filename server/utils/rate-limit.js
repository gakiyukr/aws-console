// 登入限流：以 D1 原子 upsert 持久化跨 isolate 的失敗計數與封鎖狀態。
// SQL 與參數集中在 db.js，此模組僅提供路由層使用的組合操作，
// 讓 login 端點不需直接碰 SQL。
import {
  clearLoginFailures as clearFailuresInDb,
  getLoginBlockState,
  recordLoginFailure as recordFailureInDb,
} from "./db.js";

/**
 * 檢查 IP 是否被封鎖中。
 * @returns {Promise<{blocked: boolean, retryAfterMs: number}>}
 */
export function isLoginBlocked(db, ip, now = Date.now()) {
  return getLoginBlockState(db, ip, now);
}

/**
 * 記錄一次失敗並回傳是否因此進入封鎖。
 * @returns {Promise<{blocked: boolean, failCount: number}>}
 */
export function registerLoginFailure(db, ip, now = Date.now()) {
  return recordFailureInDb(db, ip, now);
}

/** 登入成功後清除該 IP 的失敗紀錄。 */
export function resetLoginFailures(db, ip) {
  return clearFailuresInDb(db, ip);
}
