// 部署後自動登錄測試：確保兩個來源主控台的資源能匯入同一份電源管理清單。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectDeploymentMachines,
  registerDeploymentMachines,
} from "../server/utils/deployment-registration.js";
import { listMachines } from "../server/utils/db.js";
import { createDb } from "./d1-stub.js";

describe("部署執行個體登錄", () => {
  it("Wavelength 部署與其 forwarder 會以正確類型登錄", async () => {
    const db = createDb();
    const result = {
      instance_id: "i-wavelength",
      forwarder: { instance_id: "i-forwarder" },
    };

    const registrations = await registerDeploymentMachines(
      db,
      "wavelength",
      "us-east-1",
      result,
    );

    assert.deepEqual(registrations, [
      { instanceId: "i-wavelength", isWavelength: true, registration: "created", id: 1 },
      { instanceId: "i-forwarder", isWavelength: false, registration: "created", id: 2 },
    ]);
    assert.deepEqual(
      (await listMachines(db)).map(({ instanceId, isWavelength }) => ({ instanceId, isWavelength })),
      [
        { instanceId: "i-wavelength", isWavelength: true },
        { instanceId: "i-forwarder", isWavelength: false },
      ],
    );
  });

  it("既有 Wavelength 執行個體建立 forwarder 時會登錄兩者", () => {
    assert.deepEqual(
      collectDeploymentMachines("forwarder", {
        target_instance_id: "i-wavelength",
        forwarder: { instance_id: "i-forwarder" },
      }),
      [
        { instanceId: "i-wavelength", isWavelength: true },
        { instanceId: "i-forwarder", isWavelength: false },
      ],
    );
  });

  it("重複部署結果不會新增重複的機器清單記錄", async () => {
    const db = createDb();
    const result = { instance_id: "i-regional" };

    await registerDeploymentMachines(db, "regional", "ap-northeast-1", result);
    const registrations = await registerDeploymentMachines(db, "regional", "ap-northeast-1", result);

    assert.deepEqual(registrations, [
      { instanceId: "i-regional", isWavelength: false, registration: "existing" },
    ]);
    assert.equal((await listMachines(db)).length, 1);
  });

  it("資料庫 binding 缺失時仍保留 AWS 部署成功結果", async () => {
    const registrations = await registerDeploymentMachines(
      null,
      "regional",
      "us-east-1",
      { instance_id: "i-regional" },
    );

    assert.deepEqual(registrations, [
      { instanceId: "i-regional", isWavelength: false, registration: "unavailable" },
    ]);
  });
});
