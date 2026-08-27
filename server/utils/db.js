// D1 資料存取層：所有 SQL 集中於此，路由檔只呼叫這些函式，
// 使業務邏輯可在 node --test 以記憶體 D1 樁直接驗證。
// 慣例：每個函式的第一個參數都是 D1 binding（env.DB），
// 不在模組內持有任何連線狀態，以符合 Workers 每請求注入的模式。

// ─── 機器清單 ───────────────────────────────────────────────

/**
 * 取得全部受管機器（依新增順序）。
 * @param {D1Database} db
 * @returns {Promise<Array<{id:number, region:string, instanceId:string, name:string, isWavelength:boolean, createdAt:string}>>}
 */
export async function listMachines(db) {
  const { results } = await db
    .prepare("SELECT id, region, instance_id AS instanceId, name, is_wavelength AS isWavelength, created_at AS createdAt FROM machines ORDER BY id")
    .all();
  // is_wavelength 以 0/1 儲存，統一在此轉為布林，避免各呼叫端重複轉換
  return results.map((row) => ({ ...row, isWavelength: Boolean(row.isWavelength) }));
}

/**
 * 新增機器；同一 (region, instanceId) 重複時回 null 而非拋錯，
 * 讓路由層能回應 409 語意而不需解析 SQLite 錯誤字串。
 * @returns {Promise<{id:number}|null>} null 表示已存在
 */
export async function createMachine(db, { region, instanceId, name, isWavelength }) {
  try {
    const result = await db
      .prepare("INSERT INTO machines (region, instance_id, name, is_wavelength) VALUES (?1, ?2, ?3, ?4)")
      .bind(region, instanceId, name, isWavelength ? 1 : 0)
      .run();
    return { id: result.meta.last_row_id };
  } catch (error) {
    // D1 的 UNIQUE 衝突訊息含 "UNIQUE constraint failed"
    if (String(error?.message || error).includes("UNIQUE")) {
      return null;
    }
    throw error;
  }
}

/** 依主鍵取得單一機器；不存在回 null。 */
export async function getMachineById(db, id) {
  const row = await db
    .prepare("SELECT id, region, instance_id AS instanceId, name, is_wavelength AS isWavelength FROM machines WHERE id = ?1")
    .bind(id)
    .first();
  return row ? { ...row, isWavelength: Boolean(row.isWavelength) } : null;
}

/** 移除機器；回傳是否確實刪除任一列。 */
export async function deleteMachine(db, id) {
  const result = await db.prepare("DELETE FROM machines WHERE id = ?1").bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

// ─── 操作日誌 ───────────────────────────────────────────────

/**
 * @typedef {object} OperationLogEntry
 * @property {string} action
 * @property {string | null | undefined} [region]
 * @property {string | null | undefined} [instanceId]
 * @property {string} status
 * @property {unknown} [detail]
 */

/**
 * 寫入一筆操作日誌。detail 接受任意值：字串直接存入，
 * 其他型別序列化為 JSON；null/undefined 存 NULL。
 * 寫入失敗不應中斷主流程，由呼叫端決定是否另行處理，
 * 因此此函式僅在資料庫層拋錯時向上傳遞（呼叫端以 catch 吞掉）。
 * @param {any} db
 * @param {OperationLogEntry} entry
 */
export async function appendOperationLog(db, entry) {
  const {
    action,
    region = null,
    instanceId = null,
    status,
    detail = null,
  } = entry;
  const serialized = detail === null || detail === undefined
    ? null
    : (typeof detail === "string" ? detail : JSON.stringify(detail));
  await db
    .prepare("INSERT INTO operation_log (action, region, instance_id, status, detail) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(action, region, instanceId, status, serialized)
    .run();
}

/**
 * @typedef {object} OperationLogQuery
 * @property {string} [action]
 * @property {string} [status]
 * @property {number | string} [limit]
 */

/**
 * 查詢操作日誌（新→舊）。
 * @param {any} db
 * @param {OperationLogQuery} [options] 可選篩選條件
 */
export async function listOperationLogs(db, options = {}) {
  const { action, status, limit = 200 } = options;
  const conditions = [];
  const bindings = [];
  if (action) {
    conditions.push("action = ?");
    bindings.push(action);
  }
  if (status) {
    conditions.push("status = ?");
    bindings.push(status);
  }
  const whereSql = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const numericLimit = Number(limit);
  const safeLimit = Number.isFinite(numericLimit) && numericLimit >= 1
    ? Math.min(Math.trunc(numericLimit), 1000)
    : 200;
  bindings.push(safeLimit);
  const { results } = await db
    .prepare(`SELECT id, created_at AS createdAt, action, region, instance_id AS instanceId, status, detail FROM operation_log${whereSql} ORDER BY id DESC LIMIT ?`)
    .bind(...bindings)
    .all();
  return results;
}

// ─── 登入限流 ───────────────────────────────────────────────

// 限流參數沿用電源主控台原值：15 分鐘視窗內 5 次失敗 → 封鎖 15 分鐘。
export const LOGIN_FAILURE_LIMIT = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_BLOCK_MS = 15 * 60 * 1000;

/**
 * 查詢某 IP 目前是否處於封鎖狀態。
 * @returns {Promise<{blocked: boolean, retryAfterMs: number}>}
 */
export async function getLoginBlockState(db, ip, now = Date.now()) {
  const row = await db
    .prepare("SELECT fail_count, window_start, blocked_until FROM login_rate_limit WHERE ip = ?1")
    .bind(ip)
    .first();
  if (!row) {
    return { blocked: false, retryAfterMs: 0 };
  }
  if (row.blocked_until > now) {
    return { blocked: true, retryAfterMs: row.blocked_until - now };
  }
  return { blocked: false, retryAfterMs: 0 };
}

/**
 * 記錄一次登入失敗（滑動視窗計數 + 觸發封鎖）。
 * 以單條原子 upsert 完成「視窗過期重置」與「計數遞增」，避免跨 isolate 競態：
 * 視窗過期時重置為 1 次並以現在時間開新視窗；未過期則遞增並在達上限時設定封鎖期限。
 * @returns {Promise<{blocked: boolean, failCount: number}>} blocked 表示本次失敗觸發封鎖
 */
export async function recordLoginFailure(db, ip, now = Date.now()) {
  const windowStart = now - LOGIN_WINDOW_MS;
  const blockedUntil = now + LOGIN_BLOCK_MS;
  await db
    .prepare(`
      INSERT INTO login_rate_limit (ip, fail_count, window_start, blocked_until)
      VALUES (?1, 1, ?3, 0)
      ON CONFLICT(ip) DO UPDATE SET
        fail_count = CASE
          WHEN login_rate_limit.window_start <= ?2 THEN 1
          ELSE login_rate_limit.fail_count + 1
        END,
        window_start = CASE
          WHEN login_rate_limit.window_start <= ?2 THEN ?3
          ELSE login_rate_limit.window_start
        END,
        blocked_until = CASE
          WHEN (CASE
            WHEN login_rate_limit.window_start <= ?2 THEN 1
            ELSE login_rate_limit.fail_count + 1
          END) >= ?4 THEN ?5
          ELSE login_rate_limit.blocked_until
        END
    `)
    .bind(ip, windowStart, now, LOGIN_FAILURE_LIMIT, blockedUntil)
    .run();

  // SQLite changes() 無法直接取得更新後的欄位值，回讀一次取得最終計數
  const row = await db
    .prepare("SELECT fail_count, blocked_until FROM login_rate_limit WHERE ip = ?1")
    .bind(ip)
    .first();
  return {
    blocked: Boolean(row && row.blocked_until > now),
    failCount: row ? row.fail_count : 1,
  };
}

/** 登入成功後清除該 IP 的失敗計數。 */
export async function clearLoginFailures(db, ip) {
  await db.prepare("DELETE FROM login_rate_limit WHERE ip = ?1").bind(ip).run();
}
