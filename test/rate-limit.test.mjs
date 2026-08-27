// rate-limit.js 封裝層的測試：以記憶體 D1 樁驗證封鎖判定、
// 失敗計數觸發封鎖、成功登入清除計數的完整流程。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDb } from "./d1-stub.js";
import { LOGIN_FAILURE_LIMIT } from "../server/utils/db.js";
import {
  isLoginBlocked,
  registerLoginFailure,
  resetLoginFailures,
} from "../server/utils/rate-limit.js";

describe("rate-limit", () => {
  it("LOGIN_FAILURE_LIMIT 維持 5 次", () => {
    assert.equal(LOGIN_FAILURE_LIMIT, 5);
  });

  it("無失敗記錄的 IP 不被封鎖", async () => {
    const db = createDb();
    const state = await isLoginBlocked(db, "1.2.3.4");
    assert.equal(state.blocked, false);
    assert.equal(state.retryAfterMs, 0);
  });

  it("失敗次數未達上限時不封鎖，計數正確累積", async () => {
    const db = createDb();
    const now = 1_700_000_000_000;
    for (let i = 1; i < LOGIN_FAILURE_LIMIT; i++) {
      const result = await registerLoginFailure(db, "1.2.3.4", now);
      assert.equal(result.blocked, false);
      assert.equal(result.failCount, i);
    }
  });

  it("達上限的失敗觸發 15 分鐘封鎖", async () => {
    const db = createDb();
    const now = 1_700_000_000_000;
    let last;
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) {
      last = await registerLoginFailure(db, "1.2.3.4", now);
    }
    assert.equal(last.blocked, true);
    assert.equal(last.failCount, LOGIN_FAILURE_LIMIT);

    const state = await isLoginBlocked(db, "1.2.3.4", now + 1000);
    assert.equal(state.blocked, true);
    assert.equal(state.retryAfterMs > 0, true);
  });

  it("封鎖到期後不再阻擋", async () => {
    const db = createDb();
    const now = 1_700_000_000_000;
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) {
      await registerLoginFailure(db, "1.2.3.4", now);
    }
    const state = await isLoginBlocked(db, "1.2.3.4", now + 15 * 60 * 1000);
    assert.equal(state.blocked, false);
  });

  it("視窗過期後計數重置為 1 而非累積舊次數", async () => {
    const db = createDb();
    const base = 1_700_000_000_000;
    // 累積至差一次封鎖
    for (let i = 0; i < LOGIN_FAILURE_LIMIT - 1; i++) {
      await registerLoginFailure(db, "1.2.3.4", base);
    }
    // 超過 15 分鐘視窗後再失敗一次
    const result = await registerLoginFailure(db, "1.2.3.4", base + 16 * 60 * 1000);
    assert.equal(result.failCount, 1);
    assert.equal(result.blocked, false);
  });

  it("登入成功清除計數後重新計算", async () => {
    const db = createDb();
    const now = 1_700_000_000_000;
    for (let i = 0; i < LOGIN_FAILURE_LIMIT - 2; i++) {
      await registerLoginFailure(db, "1.2.3.4", now);
    }
    await resetLoginFailures(db, "1.2.3.4");
    const state = await isLoginBlocked(db, "1.2.3.4", now);
    assert.equal(state.blocked, false);

    // 清除後再失敗應從 1 開始
    const result = await registerLoginFailure(db, "1.2.3.4", now);
    assert.equal(result.failCount, 1);
  });

  it("不同 IP 的失敗計數互不影響", async () => {
    const db = createDb();
    const now = 1_700_000_000_000;
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) {
      await registerLoginFailure(db, "1.2.3.4", now);
    }
    // 另一個 IP 完全不受影響
    const other = await isLoginBlocked(db, "5.6.7.8", now);
    assert.equal(other.blocked, false);
    const otherFailure = await registerLoginFailure(db, "5.6.7.8", now);
    assert.equal(otherFailure.failCount, 1);
  });
});
