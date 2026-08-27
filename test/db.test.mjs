// db.js 的單元測試：以記憶體 D1 樁驗證機器 CRUD、操作日誌、
// 登入限流的視窗重置與封鎖語意。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LOGIN_FAILURE_LIMIT,
  appendOperationLog,
  clearLoginFailures,
  createMachine,
  deleteMachine,
  getLoginBlockState,
  getMachineById,
  listMachines,
  listOperationLogs,
  recordLoginFailure,
} from "../server/utils/db.js";
import { createDb } from "./d1-stub.js";

describe("machines CRUD", () => {
  it("新增後可列出並以 id 取得", async () => {
    const db = createDb();
    const created = await createMachine(db, {
      region: "us-east-1",
      instanceId: "i-0abc123",
      name: "SEA-1",
      isWavelength: true,
    });
    assert.ok(created.id > 0);

    const machines = await listMachines(db);
    assert.equal(machines.length, 1);
    assert.equal(machines[0].instanceId, "i-0abc123");
    assert.equal(machines[0].isWavelength, true);

    const fetched = await getMachineById(db, created.id);
    assert.equal(fetched.name, "SEA-1");
  });

  it("同一 (region, instanceId) 重複新增回 null", async () => {
    const db = createDb();
    await createMachine(db, { region: "us-east-1", instanceId: "i-1", name: "A", isWavelength: false });
    const duplicate = await createMachine(db, { region: "us-east-1", instanceId: "i-1", name: "B", isWavelength: false });
    assert.equal(duplicate, null);
    assert.equal((await listMachines(db)).length, 1);
  });

  it("isWavelength 以布林正規化", async () => {
    const db = createDb();
    await createMachine(db, { region: "ap-northeast-1", instanceId: "i-2", name: "WL", isWavelength: false });
    const [machine] = await listMachines(db);
    assert.equal(machine.isWavelength, false);
  });

  it("deleteMachine 移除存在的記錄回 true，不存在回 false", async () => {
    const db = createDb();
    const { id } = await createMachine(db, { region: "us-east-1", instanceId: "i-3", name: "X", isWavelength: false });
    assert.equal(await deleteMachine(db, id), true);
    assert.equal(await deleteMachine(db, id), false);
    assert.equal(await getMachineById(db, id), null);
  });
});

describe("operation_log", () => {
  it("寫入後以新→舊排序查詢，detail 物件序列化為 JSON", async () => {
    const db = createDb();
    await appendOperationLog(db, { action: "start", region: "us-east-1", instanceId: "i-1", status: "success" });
    await appendOperationLog(db, {
      action: "stop",
      region: "us-east-1",
      instanceId: "i-1",
      status: "failure",
      detail: { message: "throttled" },
    });

    const logs = await listOperationLogs(db);
    assert.equal(logs.length, 2);
    assert.equal(logs[0].action, "stop"); // 後寫入的在前
    assert.equal(logs[0].status, "failure");
    assert.deepEqual(JSON.parse(logs[0].detail), { message: "throttled" });
    assert.equal(logs[1].detail, null);
  });

  it("支援 action 與 status 篩選及 limit", async () => {
    const db = createDb();
    for (let i = 0; i < 5; i++) {
      await appendOperationLog(db, { action: i % 2 ? "start" : "stop", status: i < 3 ? "success" : "failure" });
    }
    const started = await listOperationLogs(db, { action: "start" });
    assert.equal(started.length, 2);
    const failures = await listOperationLogs(db, { status: "failure" });
    assert.equal(failures.length, 2);
    const limited = await listOperationLogs(db, { limit: 3 });
    assert.equal(limited.length, 3);

    const invalidLimit = await listOperationLogs(db, { limit: "not-a-number" });
    assert.equal(invalidLimit.length, 5);
  });
});

describe("登入限流", () => {
  const MINUTE = 60 * 1000;

  it("無記錄時不封鎖", async () => {
    const db = createDb();
    const state = await getLoginBlockState(db, "1.2.3.4", 1_000_000);
    assert.equal(state.blocked, false);
  });

  it("累計達上限後觸發封鎖", async () => {
    const db = createDb();
    const now = 1_700_000_000_000;
    let last;
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) {
      last = await recordLoginFailure(db, "1.2.3.4", now + i * MINUTE);
    }
    assert.equal(last.blocked, true);
    assert.equal(last.failCount, LOGIN_FAILURE_LIMIT);

    const state = await getLoginBlockState(db, "1.2.3.4", now + 5 * MINUTE);
    assert.equal(state.blocked, true);
    assert.ok(state.retryAfterMs > 0);
  });

  it("視窗過期後計數重置為 1", async () => {
    const db = createDb();
    const now = 1_700_000_000_000;
    for (let i = 0; i < LOGIN_FAILURE_LIMIT - 1; i++) {
      await recordLoginFailure(db, "1.2.3.4", now + i * MINUTE);
    }
    // 超過 15 分鐘視窗的下一次失敗應重置
    const result = await recordLoginFailure(db, "1.2.3.4", now + 20 * MINUTE);
    assert.equal(result.failCount, 1);
    assert.equal(result.blocked, false);
  });

  it("封鎖到期後 getLoginBlockState 回復未封鎖", async () => {
    const db = createDb();
    const now = 1_700_000_000_000;
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) {
      await recordLoginFailure(db, "1.2.3.4", now + i * MINUTE);
    }
    const after = now + 5 * MINUTE + 15 * MINUTE + 1;
    const state = await getLoginBlockState(db, "1.2.3.4", after);
    assert.equal(state.blocked, false);
  });

  it("登入成功後清除計數", async () => {
    const db = createDb();
    const now = 1_700_000_000_000;
    await recordLoginFailure(db, "1.2.3.4", now);
    await recordLoginFailure(db, "1.2.3.4", now + MINUTE);
    await clearLoginFailures(db, "1.2.3.4");
    const state = await getLoginBlockState(db, "1.2.3.4", now + 2 * MINUTE);
    assert.equal(state.blocked, false);
    // 重新計數從 0 開始
    const result = await recordLoginFailure(db, "1.2.3.4", now + 3 * MINUTE);
    assert.equal(result.failCount, 1);
  });

  it("不同 IP 互不影響", async () => {
    const db = createDb();
    const now = 1_700_000_000_000;
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) {
      await recordLoginFailure(db, "1.1.1.1", now + i);
    }
    const result = await recordLoginFailure(db, "2.2.2.2", now);
    assert.equal(result.blocked, false);
  });
});
