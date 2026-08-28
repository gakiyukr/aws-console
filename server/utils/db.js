// D1 資料存取層：所有 SQL 集中於此，路由檔只呼叫這些函式，
// 使業務邏輯可在 node --test 以記憶體 D1 樁直接驗證。
// 慣例：每個函式的第一個參數都是 D1 binding（env.DB），
// 不在模組內持有任何連線狀態，以符合 Workers 每請求注入的模式。

// ─── 機器清單 ───────────────────────────────────────────────

/**
 * 取得全部受管機器（依新增順序）。
 * @param {D1Database} db
 * @returns {Promise<Array<{id:number, awsAccountId:number|null, region:string, instanceId:string, name:string, isWavelength:boolean, createdAt:string}>>}
 */
export async function listMachines(db) {
  const { results } = await db
    .prepare("SELECT id, aws_account_id AS awsAccountId, region, instance_id AS instanceId, name, is_wavelength AS isWavelength, created_at AS createdAt FROM machines ORDER BY id")
    .all();
  // is_wavelength 以 0/1 儲存，統一在此轉為布林，避免各呼叫端重複轉換
  return results.map((row) => ({ ...row, isWavelength: Boolean(row.isWavelength) }));
}

/**
 * 新增機器；同一 (region, instanceId) 重複時回 null 而非拋錯，
 * 讓路由層能回應 409 語意而不需解析 SQLite 錯誤字串。
 * @returns {Promise<{id:number}|null>} null 表示已存在
 */
export async function createMachine(db, { awsAccountId = /** @type {number|null} */ (null), region, instanceId, name, isWavelength }) {
  try {
    const result = await db
      .prepare("INSERT INTO machines (aws_account_id, region, instance_id, name, is_wavelength) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(awsAccountId, region, instanceId, name, isWavelength ? 1 : 0)
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
    .prepare("SELECT id, aws_account_id AS awsAccountId, region, instance_id AS instanceId, name, is_wavelength AS isWavelength FROM machines WHERE id = ?1")
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
 * @property {number | null} [awsAccountId]
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
    awsAccountId = null,
  } = entry;
  const serialized = detail === null || detail === undefined
    ? null
    : (typeof detail === "string" ? detail : JSON.stringify(detail));
  await db
    .prepare("INSERT INTO operation_log (aws_account_id, action, region, instance_id, status, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(awsAccountId, action, region, instanceId, status, serialized)
    .run();
}

/**
 * @typedef {object} OperationLogQuery
 * @property {string} [action]
 * @property {string} [status]
 * @property {number | string} [limit]
 * @property {number | string} [awsAccountId]
 */

/**
 * 查詢操作日誌（新→舊）。
 * @param {any} db
 * @param {OperationLogQuery} [options] 可選篩選條件
 */
export async function listOperationLogs(db, options = {}) {
  const { action, status, awsAccountId, limit = 200 } = options;
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
  if (awsAccountId) {
    conditions.push("aws_account_id = ?");
    bindings.push(Number(awsAccountId));
  }
  const whereSql = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const numericLimit = Number(limit);
  const safeLimit = Number.isFinite(numericLimit) && numericLimit >= 1
    ? Math.min(Math.trunc(numericLimit), 1000)
    : 200;
  bindings.push(safeLimit);
  const { results } = await db
    .prepare(`SELECT id, aws_account_id AS awsAccountId, created_at AS createdAt, action, region, instance_id AS instanceId, status, detail FROM operation_log${whereSql} ORDER BY id DESC LIMIT ?`)
    .bind(...bindings)
    .all();
  return results;
}

// ─── AWS 帳號 ───────────────────────────────────────────────────────────────

const ACCOUNT_COLUMNS = "id, name, credential_ciphertext AS credentialCiphertext, credential_iv AS credentialIv, access_key_hint AS accessKeyHint, encryption_key_version AS encryptionKeyVersion, enabled, is_default AS isDefault, last_verified_at AS lastVerifiedAt, created_at AS createdAt, updated_at AS updatedAt";

function normalizeAccount(row) {
  return row ? { ...row, enabled: Boolean(row.enabled), isDefault: Boolean(row.isDefault) } : null;
}

export async function listAwsAccounts(db) {
  const { results } = await db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM aws_accounts ORDER BY id`).all();
  return results.map(normalizeAccount);
}

export async function getAwsAccountById(db, id) {
  return normalizeAccount(await db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM aws_accounts WHERE id = ?1`).bind(id).first());
}

export async function getDefaultAwsAccount(db) {
  return normalizeAccount(await db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM aws_accounts WHERE is_default = 1`).first());
}

export async function createAwsAccount(db, account) {
  const existing = await listAwsAccounts(db);
  if (existing.length === 0 && account.enabled === false)
    throw new Error("第一個 AWS 帳號必須保持啟用");
  if (existing.some(item => item.name === account.name))
    return null;
  const isDefault = account.isDefault || existing.length === 0;
  if (isDefault)
    await db.prepare("UPDATE aws_accounts SET is_default = 0, updated_at = datetime('now') WHERE is_default = 1").run();
  try {
    const result = await db.prepare(`INSERT INTO aws_accounts
      (name, credential_ciphertext, credential_iv, access_key_hint, encryption_key_version, enabled, is_default)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
      .bind(account.name, account.credentialCiphertext, account.credentialIv, account.accessKeyHint, account.encryptionKeyVersion, account.enabled === false ? 0 : 1, isDefault ? 1 : 0)
      .run();
    const id = result.meta.last_row_id;
    if (existing.length === 0) {
      await db.prepare("UPDATE machines SET aws_account_id = ?1 WHERE aws_account_id IS NULL").bind(id).run();
    }
    return getAwsAccountById(db, id);
  } catch (error) {
    if (String(error?.message || error).includes("UNIQUE"))
      return null;
    throw error;
  }
}

export async function updateAwsAccount(db, id, account) {
  const existing = await listAwsAccounts(db);
  if (existing.some(item => item.id !== id && item.name === account.name))
    return null;
  if (account.isDefault)
    await db.prepare("UPDATE aws_accounts SET is_default = 0, updated_at = datetime('now') WHERE is_default = 1").run();
  const result = await db.prepare(`UPDATE aws_accounts SET
    name = ?2, credential_ciphertext = ?3, credential_iv = ?4, access_key_hint = ?5,
    encryption_key_version = ?6, enabled = ?7, is_default = ?8, updated_at = datetime('now')
    WHERE id = ?1`)
    .bind(id, account.name, account.credentialCiphertext, account.credentialIv, account.accessKeyHint, account.encryptionKeyVersion, account.enabled ? 1 : 0, account.isDefault ? 1 : 0)
    .run();
  return (result.meta.changes ?? 0) > 0 ? getAwsAccountById(db, id) : null;
}

export async function markAwsAccountVerified(db, id) {
  await db.prepare("UPDATE aws_accounts SET last_verified_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1").bind(id).run();
}

export async function countMachinesForAwsAccount(db, id) {
  const { results } = await db.prepare("SELECT id FROM machines WHERE aws_account_id = ?1").bind(id).all();
  return results.length;
}

export async function deleteAwsAccount(db, id) {
  if (await countMachinesForAwsAccount(db, id))
    return { deleted: false, reason: "in_use" };
  const account = await getAwsAccountById(db, id);
  if (!account)
    return { deleted: false, reason: "not_found" };
  const result = await db.prepare("DELETE FROM aws_accounts WHERE id = ?1").bind(id).run();
  if (account.isDefault) {
    const next = (await listAwsAccounts(db)).find(item => item.enabled);
    if (next)
      await db.prepare("UPDATE aws_accounts SET is_default = 1, updated_at = datetime('now') WHERE id = ?1").bind(next.id).run();
  }
  return { deleted: (result.meta.changes ?? 0) > 0 };
}

// ─── 主控台使用者 ───────────────────────────────────────────────────────────

const USER_COLUMNS = "id, username, password_hash AS passwordHash, password_salt AS passwordSalt, password_iterations AS passwordIterations, role, enabled, auth_version AS authVersion, created_at AS createdAt, updated_at AS updatedAt";

function normalizeUser(row) {
  return row ? { ...row, enabled: Boolean(row.enabled) } : null;
}

export async function listUsers(db) {
  const { results } = await db.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY id`).all();
  return results.map(normalizeUser);
}

export async function getUserById(db, id) {
  return normalizeUser(await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?1`).bind(id).first());
}

export async function getUserByUsername(db, username) {
  return normalizeUser(await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE username = ?1`).bind(username).first());
}

export async function createUser(db, user) {
  try {
    const result = await db.prepare(`INSERT INTO users
      (username, password_hash, password_salt, password_iterations, role, enabled)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
      .bind(user.username, user.passwordHash, user.passwordSalt, user.passwordIterations, user.role || "admin", user.enabled === false ? 0 : 1)
      .run();
    return getUserById(db, result.meta.last_row_id);
  } catch (error) {
    if (String(error?.message || error).includes("UNIQUE"))
      return null;
    throw error;
  }
}

export async function updateUser(db, id, user) {
  const result = await db.prepare(`UPDATE users SET username = ?2, password_hash = ?3,
    password_salt = ?4, password_iterations = ?5, role = ?6, enabled = ?7,
    auth_version = auth_version + ?8, updated_at = datetime('now') WHERE id = ?1`)
    .bind(id, user.username, user.passwordHash, user.passwordSalt, user.passwordIterations, user.role, user.enabled ? 1 : 0, user.invalidateSessions ? 1 : 0)
    .run();
  return (result.meta.changes ?? 0) > 0 ? getUserById(db, id) : null;
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
