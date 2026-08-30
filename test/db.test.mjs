// db.js 的單元測試：以記憶體 D1 樁驗證機器 CRUD、操作日誌。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appendOperationLog,
  createAwsAccount,
  createMachine,
  createSshPublicKey,
  deleteAwsAccount,
  deleteMachine,
  deleteSshPublicKey,
  getMachineById,
  getSshPublicKeyById,
  listMachines,
  listOperationLogs,
  listSshPublicKeys,
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

describe("ssh_public_keys CRUD", () => {
  const KEY_A = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB8Q2OmB3ZPG1P7jZu9mJcOZ a@host";
  const KEY_B = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ b@host";

  it("新增後可列出並以 id 取得", async () => {
    const db = createDb();
    const created = await createSshPublicKey(db, { label: "MacBook", publicKey: KEY_A });
    assert.ok(created.id > 0);
    await createSshPublicKey(db, { label: "Server", publicKey: KEY_B });

    const keys = await listSshPublicKeys(db);
    assert.equal(keys.length, 2);
    assert.equal(keys[0].label, "MacBook"); // 依 id 遞增排序
    assert.equal(keys[0].publicKey, KEY_A);
    assert.ok(keys[0].createdAt);

    const fetched = await getSshPublicKeyById(db, created.id);
    assert.equal(fetched.label, "MacBook");
  });

  it("同一公鑰重複新增回 null", async () => {
    const db = createDb();
    await createSshPublicKey(db, { label: "A", publicKey: KEY_A });
    const duplicate = await createSshPublicKey(db, { label: "B", publicKey: KEY_A });
    assert.equal(duplicate, null);
    assert.equal((await listSshPublicKeys(db)).length, 1);
  });

  it("deleteSshPublicKey 移除存在的記錄回 true，不存在回 false", async () => {
    const db = createDb();
    const { id } = await createSshPublicKey(db, { label: "A", publicKey: KEY_A });
    assert.equal(await deleteSshPublicKey(db, id), true);
    assert.equal(await deleteSshPublicKey(db, id), false);
    assert.equal(await getSshPublicKeyById(db, id), null);
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

describe("AWS 帳號與資料關聯", () => {
  const encrypted = {
    credentialCiphertext: "ciphertext",
    credentialIv: "iv",
    accessKeyHint: "1234",
    encryptionKeyVersion: 1,
  };

  it("第一個帳號自動成為預設並接管舊機器", async () => {
    const db = createDb();
    await createMachine(db, { region: "us-west-2", instanceId: "i-legacy", name: "舊機器", isWavelength: false });
    const account = await createAwsAccount(db, { name: "正式帳號", ...encrypted, enabled: true });
    assert.equal(account.isDefault, true);
    assert.equal((await listMachines(db))[0].awsAccountId, account.id);
  });

  it("帳號名稱不可重複，且仍有機器時不可刪除", async () => {
    const db = createDb();
    const account = await createAwsAccount(db, { name: "正式帳號", ...encrypted, enabled: true });
    assert.equal(await createAwsAccount(db, { name: "正式帳號", ...encrypted, enabled: true }), null);
    const machine = await createMachine(db, { awsAccountId: account.id, region: "us-east-1", instanceId: "i-1", name: "A", isWavelength: false });
    assert.equal((await deleteAwsAccount(db, account.id)).reason, "in_use");
    await deleteMachine(db, machine.id);
    assert.equal((await deleteAwsAccount(db, account.id)).deleted, true);
  });

  it("操作日誌可依 AWS 帳號篩選", async () => {
    const db = createDb();
    await appendOperationLog(db, { awsAccountId: 1, action: "start", status: "success" });
    await appendOperationLog(db, { awsAccountId: 2, action: "stop", status: "success" });
    const logs = await listOperationLogs(db, { awsAccountId: 2 });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].awsAccountId, 2);
  });
});

