// 記憶體版 D1 樁：實作測試所需的最小 D1 介面（prepare/bind/first/all/run/batch），
// 以極簡 SQL 直譯支援本專案用到的語句形態——SELECT/WHERE 等值條件（含 ?N 編號
// 佔位符與 ? 依序佔位符）、AS 別名投影、ORDER BY 單欄排序、LIMIT、
// INSERT ... VALUES、DELETE ... WHERE、以及 login_rate_limit 的
// INSERT ... ON CONFLICT(ip) DO UPDATE SET col = CASE ... END。
// 不追求通用 SQL 支援；新增查詢若超出此範圍，需同步擴充此樁。

/** 將 D1 result 物件塑形成 { results, meta }。 */
function makeResult(rows, meta = {}) {
  return {
    results: rows,
    meta: { changes: 0, last_row_id: null, duration: 0, ...meta },
  };
}

// 具 AUTOINCREMENT 主鍵的表：INSERT 未提供 id 時自動補號
const AUTO_ID_TABLES = new Set(["machines", "operation_log", "aws_accounts", "users"]);

export class D1Stub {
  constructor() {
    // table 名 → 陣列列；欄位名區分大小寫，與 migration 定義一致
    this.tables = new Map();
    this.lastRowId = 0;
  }

  createTable(name) {
    if (!this.tables.has(name)) {
      this.tables.set(name, []);
    }
  }

  prepare(sql) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    const bound = [];
    const statement = {
      bind: (...values) => {
        bound.push(...values);
        return statement;
      },
      first: async () => {
        const rows = statement._execute();
        return rows[0] ?? null;
      },
      all: async () => ({ results: statement._execute() }),
      run: async () => statement._executeRun(),
      // 內部執行：回傳 SELECT 的結果列（其他語句回空陣列）
      _execute: () => this._runSql(normalized, bound).rows,
      _executeRun: () => this._runSql(normalized, bound).result,
    };
    return statement;
  }

  async batch(statements) {
    const results = [];
    for (const stmt of statements) {
      results.push(await stmt.run());
    }
    return results;
  }

  /**
   * 解析單一佔位符為綁定值。
   * @param {string} token "?N"（依編號取 bound[N-1]）或 "?"（依出現順序取值）
   * @param {Array} bound 綁定參數
   * @param {{index: number}} cursor 依序佔位符的消費游標（跨呼叫共享）
   */
  _resolveValue(token, bound, cursor) {
    if (token === "?") {
      if (cursor.index >= bound.length) {
        throw new Error(`D1Stub 綁定參數不足（需要第 ${cursor.index + 1} 個）`);
      }
      return bound[cursor.index++];
    }
    const numbered = token.match(/^\?(\d+)$/);
    if (numbered) {
      return bound[Number(numbered[1]) - 1];
    }
    if (/^-?\d+(\.\d+)?$/.test(token)) {
      return Number(token);
    }
    return token.replace(/^'|'$/g, "");
  }

  /** 解析並執行單一語句，回傳 { rows, result }。 */
  _runSql(sql, bound) {
    if (/^SELECT /i.test(sql)) {
      return { rows: this._select(sql, bound), result: makeResult([]) };
    }
    if (/^INSERT INTO (\w+)/i.test(sql)) {
      const table = sql.match(/^INSERT INTO (\w+)/i)[1];
      return { rows: [], result: this._insert(table, sql, bound) };
    }
    if (/^DELETE FROM (\w+)/i.test(sql)) {
      const table = sql.match(/^DELETE FROM (\w+)/i)[1];
      return { rows: [], result: this._delete(table, sql, bound) };
    }
    if (/^UPDATE (\w+)/i.test(sql)) {
      const table = sql.match(/^UPDATE (\w+)/i)[1];
      return { rows: [], result: this._update(table, sql, bound) };
    }
    throw new Error(`D1Stub 不支援的語句: ${sql}`);
  }

  /**
   * 解析 SELECT 的 WHERE / ORDER BY / LIMIT / 欄位投影。
   * 僅支援以 AND 串接的等值條件；條件值在過濾前一次性解析，
   * 避免逐列消費綁定參數造成錯位。
   */
  _select(sql, bound) {
    const fromMatch = sql.match(/FROM (\w+)/i);
    if (!fromMatch) {
      throw new Error(`D1Stub 無法解析 FROM: ${sql}`);
    }
    const table = fromMatch[1];
    const cursor = { index: 0 };

    let filtered = (this.tables.get(table) || []).map((row) => ({ ...row }));

    const whereMatch = sql.match(/WHERE (.+?)(?: ORDER BY| LIMIT|$)/i);
    if (whereMatch) {
      const conditions = whereMatch[1].split(/ AND /i).map((cond) => {
        const eq = cond.match(/(\w+)\s*=\s*(\?\d*|-?\d+|'[^']*')/);
        if (!eq) {
          throw new Error(`D1Stub 無法解析條件: ${cond}`);
        }
        return { column: eq[1], value: this._resolveValue(eq[2], bound, cursor) };
      });
      filtered = filtered.filter((row) =>
        conditions.every(({ column, value }) => row[column] === value),
      );
    }

    // LIMIT ? 或 LIMIT n
    const limitMatch = sql.match(/LIMIT (\?\d*|\d+)/i);
    if (limitMatch) {
      filtered = filtered.slice(0, this._resolveValue(limitMatch[1], bound, cursor));
    }

    // ORDER BY 單欄排序
    const orderMatch = sql.match(/ORDER BY (\w+)( DESC| ASC)?/i);
    if (orderMatch) {
      const [, column, direction] = orderMatch;
      filtered.sort((a, b) => {
        const av = a[column];
        const bv = b[column];
        const cmp = av === bv ? 0 : av > bv ? 1 : -1;
        return direction?.trim().toUpperCase() === "DESC" ? -cmp : cmp;
      });
    }

    // 欄位投影：支援「col」與「col AS alias」
    const selectList = sql.match(/^SELECT (.+?) FROM/i)[1];
    if (selectList.trim() !== "*") {
      const columns = selectList.split(",").map((c) => c.trim());
      filtered = filtered.map((row) => {
        const projected = {};
        for (const column of columns) {
          const aliasMatch = column.match(/^(\w+)\s+AS\s+(\w+)$/i);
          const source = aliasMatch ? aliasMatch[1] : column;
          const key = aliasMatch ? aliasMatch[2] : column;
          projected[key] = row[source];
        }
        return projected;
      });
    }
    return filtered;
  }

  /**
   * 解析 INSERT INTO <table> (cols) VALUES (...) [ON CONFLICT(col) DO UPDATE SET ...]。
   * ON CONFLICT 分支針對 login_rate_limit 的 CASE 運算式做語意模擬：
   * 直接依 db.js 的視窗規則重算（視窗過期重置為 1，否則遞增並於達上限時封鎖）。
   */
  _insert(table, sql, bound) {
    this.createTable(table);
    const colsMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
    const valuesMatch = sql.match(/VALUES \(([^)]+)\)/i);
    if (!colsMatch || !valuesMatch) {
      throw new Error(`D1Stub 無法解析 INSERT: ${sql}`);
    }
    const columns = colsMatch[1].split(",").map((c) => c.trim());
    const placeholders = valuesMatch[1].split(",").map((v) => v.trim());
    const cursor = { index: 0 };
    const row = {};
    columns.forEach((column, i) => {
      row[column] = this._resolveValue(placeholders[i], bound, cursor);
    });

    const rows = this.tables.get(table);

    if (/ON CONFLICT/i.test(sql)) {
      const existing = rows.find((r) => r.ip === row.ip);
      if (existing) {
        // 語意重算：與 db.js recordLoginFailure 的 CASE 邏輯一致。
        // 綁定順序：?1=ip、?2=windowStart、?3=now、?4=失敗上限、?5=封鎖期限。
        const windowStart = bound[1];
        const now = bound[2];
        const failureLimit = bound[3];
        const blockedUntil = bound[4];
        if (existing.window_start <= windowStart) {
          existing.fail_count = 1;
          existing.window_start = now;
        } else {
          existing.fail_count += 1;
        }
        existing.blocked_until =
          existing.fail_count >= failureLimit ? blockedUntil : existing.blocked_until;
        return makeResult([], { changes: 1 });
      }
      rows.push(row);
      this.lastRowId += 1;
      return makeResult([], { changes: 1, last_row_id: this.lastRowId });
    }

    // 一般 INSERT：machines 表檢查 UNIQUE(region, instance_id) 語意
    if (table === "machines") {
      const duplicate = rows.some(
        (r) => r.aws_account_id === row.aws_account_id && r.region === row.region && r.instance_id === row.instance_id,
      );
      if (duplicate) {
        throw new Error("UNIQUE constraint failed: machines.region, machines.instance_id");
      }
    }
    if (table === "aws_accounts" && rows.some(r => r.name === row.name)) {
      throw new Error("UNIQUE constraint failed: aws_accounts.name");
    }
    if (table === "users" && rows.some(r => r.username === row.username)) {
      throw new Error("UNIQUE constraint failed: users.username");
    }
    if (table === "aws_accounts") {
      Object.assign(row, {
        enabled: row.enabled ?? 1,
        is_default: row.is_default ?? 0,
        last_verified_at: row.last_verified_at ?? null,
        created_at: row.created_at ?? new Date().toISOString(),
        updated_at: row.updated_at ?? new Date().toISOString(),
      });
    }
    if (table === "users") {
      Object.assign(row, {
        role: row.role ?? "admin",
        enabled: row.enabled ?? 1,
        auth_version: row.auth_version ?? 1,
        created_at: row.created_at ?? new Date().toISOString(),
        updated_at: row.updated_at ?? new Date().toISOString(),
      });
    }
    if (AUTO_ID_TABLES.has(table) && row.id === undefined) {
      this.lastRowId += 1;
      row.id = this.lastRowId;
    }
    rows.push(row);
    const meta = { changes: 1 };
    if (row.id !== undefined) {
      meta.last_row_id = row.id;
    }
    return makeResult([], meta);
  }

  _delete(table, sql, bound) {
    const rows = this.tables.get(table) || [];
    const whereMatch = sql.match(/WHERE (\w+) = (\?\d*|-?\d+|'[^']*')/i);
    if (!whereMatch) {
      throw new Error(`D1Stub 無法解析 DELETE: ${sql}`);
    }
    const [, column, token] = whereMatch;
    const value = this._resolveValue(token, bound, { index: 0 });
    const remaining = rows.filter((row) => row[column] !== value);
    this.tables.set(table, remaining);
    return makeResult([], { changes: rows.length - remaining.length });
  }

  _update(table, sql, bound) {
    const rows = this.tables.get(table) || [];
    const setMatch = sql.match(/ SET (.+?)(?: WHERE (.+))?$/i);
    if (!setMatch) {
      throw new Error(`D1Stub 無法解析 UPDATE: ${sql}`);
    }
    const [, assignmentsText, whereText] = setMatch;
    const matchesWhere = (row) => {
      if (!whereText)
        return true;
      return whereText.split(/ AND /i).every((condition) => {
        const nullMatch = condition.match(/(\w+) IS NULL/i);
        if (nullMatch)
          return row[nullMatch[1]] === null || row[nullMatch[1]] === undefined;
        const equalMatch = condition.match(/(\w+)\s*=\s*(\?\d*|-?\d+|'[^']*')/);
        if (!equalMatch)
          throw new Error(`D1Stub 無法解析 UPDATE 條件: ${condition}`);
        return row[equalMatch[1]] === this._resolveValue(equalMatch[2], bound, { index: 0 });
      });
    };
    let changes = 0;
    for (const row of rows) {
      if (!matchesWhere(row))
        continue;
      const updated = { ...row };
      for (const assignment of assignmentsText.split(/,\s*/)) {
        const equalIndex = assignment.indexOf("=");
        if (equalIndex < 1)
          throw new Error(`D1Stub 無法解析 UPDATE 指派: ${assignment}`);
        const column = assignment.slice(0, equalIndex).trim();
        const expression = assignment.slice(equalIndex + 1).trim();
        const increment = expression.match(/^(\w+) \+ (\?\d*)$/);
        if (increment) {
          updated[column] = Number(updated[increment[1]]) + Number(this._resolveValue(increment[2], bound, { index: 0 }));
        }
        else if (/^datetime\('now'\)$/i.test(expression)) {
          updated[column] = new Date().toISOString();
        }
        else {
          updated[column] = this._resolveValue(expression, bound, { index: 0 });
        }
      }
      if (table === "aws_accounts" && rows.some(candidate => candidate !== row && candidate.name === updated.name)) {
        throw new Error("UNIQUE constraint failed: aws_accounts.name");
      }
      if (table === "users" && rows.some(candidate => candidate !== row && candidate.username === updated.username)) {
        throw new Error("UNIQUE constraint failed: users.username");
      }
      Object.assign(row, updated);
      changes += 1;
    }
    return makeResult([], { changes });
  }
}

/** 建立已套用 0001_init schema（空表）的樁。 */
export function createDb() {
  const stub = new D1Stub();
  for (const name of ["machines", "operation_log", "login_rate_limit", "aws_accounts", "users"]) {
    stub.createTable(name);
  }
  return stub;
}
