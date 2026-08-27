// power.js 與 machines 端點的測試：移植自 ec2-power-console 的 19 項
// 測試，AWS 互動改以 env.__testHooks.fetch 注入 fake fetch，
// D1 以記憶體樁驗證白名單與操作日誌。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDb } from "./d1-stub.js";
import {
  buildRegionGroups,
  deriveIpFromPublicDns,
  mergeMachineStates,
  parseDescribeInstancesXml,
  parseDescribeInstancesXmlItems,
  performPowerAction,
  STATE_NOT_FOUND,
  STATE_QUERY_FAILED,
} from "../server/utils/power.js";
import { appendOperationLog, createMachine, listMachines, listOperationLogs } from "../server/utils/db.js";

// ── 測試輔助 ────────────────────────────────────────────────

/** 建立含 AWS 憑證與 D1 樁的 env。 */
function makeEnv(overrides = {}) {
  return {
    AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
    AWS_SECRET_ACCESS_KEY: "secret",
    DB: overrides.db || createDb(),
    __testHooks: { fetch: overrides.fetch },
  };
}

/** 自 Request init 取出 form-urlencoded 的 Action 參數。 */
function readAction(init) {
  return new URLSearchParams(init.body).get("Action");
}

/** 建立 AWS 形態的 XML 回應。 */
function makeXmlResponse(xml, status = 200) {
  return new Response(xml, { status, headers: { "content-type": "text/xml" } });
}

const SAMPLE_INSTANCES_XML = `
<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <reservationSet>
    <item>
      <instancesSet>
        <item>
          <instanceId>i-0abc123def4567890</instanceId>
          <instanceState><code>16</code><name>running</name></instanceState>
          <dnsName>ec2-203-0-113-10.us-east-1.compute.amazonaws.com</dnsName>
          <ipAddress>203.0.113.10</ipAddress>
          <tagSet>
            <item><key>Name</key><value>web-1</value></item>
          </tagSet>
        </item>
        <item>
          <instanceId>i-0wl1111111111111</instanceId>
          <instanceState><code>16</code><name>running</name></instanceState>
          <dnsName>ec2-203-0-113-20.ap-northeast-1.compute.amazonaws.com</dnsName>
          <tagSet>
            <item><key>ManagedBy</key><value>console</value></item>
          </tagSet>
        </item>
      </instancesSet>
    </item>
  </reservationSet>
</DescribeInstancesResponse>`;

// ── deriveIpFromPublicDns ───────────────────────────────────

describe("deriveIpFromPublicDns", () => {
  it("自 compute 網域 DNS 推導 IPv4", () => {
    assert.equal(
      deriveIpFromPublicDns("ec2-155-146-130-24.us-west-2.compute.amazonaws.com"),
      "155.146.130.24",
    );
    assert.equal(
      deriveIpFromPublicDns("ec2-155-146-130-24.us-west-2.compute-1.amazonaws.com.cn"),
      "155.146.130.24",
    );
  });

  it("非 compute 網域或超過 255 的段回空字串", () => {
    assert.equal(deriveIpFromPublicDns("i-1.example.internal"), "");
    assert.equal(deriveIpFromPublicDns("ec2-999-0-0-1.compute-1.amazonaws.com"), "");
    assert.equal(deriveIpFromPublicDns(""), "");
    assert.equal(deriveIpFromPublicDns(null), "");
  });
});

// ── XML 解析 ────────────────────────────────────────────────

describe("parseDescribeInstancesXmlItems", () => {
  it("解析狀態、DNS、IP、Name 標籤", () => {
    const items = parseDescribeInstancesXmlItems(SAMPLE_INSTANCES_XML);
    assert.equal(items.length, 2);

    assert.equal(items[0].instanceId, "i-0abc123def4567890");
    assert.equal(items[0].state, "running");
    assert.equal(items[0].publicDnsName, "ec2-203-0-113-10.us-east-1.compute.amazonaws.com");
    assert.equal(items[0].publicIpAddress, "203.0.113.10");
    assert.equal(items[0].awsNameTag, "web-1");
    assert.equal(items[0].isWlInstance, false);
  });

  it("偵測 Wavelength 形態（有 DNS、無 ipAddress、可推導 IP）", () => {
    const items = parseDescribeInstancesXmlItems(SAMPLE_INSTANCES_XML);
    assert.equal(items[1].isWlInstance, true);
    assert.equal(items[1].publicIpAddress, "203.0.113.20");
  });
});

describe("parseDescribeInstancesXml", () => {
  it("回傳以 instanceId 為鍵的查找表", () => {
    const lookup = parseDescribeInstancesXml(SAMPLE_INSTANCES_XML);
    assert.equal(lookup.size, 2);
    assert.equal(lookup.get("i-0abc123def4567890").state, "running");
  });
});

// ── buildRegionGroups ───────────────────────────────────────

describe("buildRegionGroups", () => {
  it("依地區分組並按名稱排序", () => {
    const groups = buildRegionGroups([
      { region: "us-east-1", instanceId: "i-1" },
      { region: "ap-northeast-1", instanceId: "i-2" },
      { region: "us-east-1", instanceId: "i-3" },
    ]);
    assert.deepEqual(
      groups.map((g) => g.region),
      ["ap-northeast-1", "us-east-1"],
    );
    assert.equal(groups[1].items.length, 2);
  });
});

// ── mergeMachineStates ──────────────────────────────────────

describe("mergeMachineStates", () => {
  it("合併 D1 清單與即時 DescribeInstances 狀態", async () => {
    const db = createDb();
    await createMachine(db, { region: "us-east-1", instanceId: "i-0abc123def4567890", name: "", isWavelength: false });
    await createMachine(db, { region: "us-east-1", instanceId: "i-missing000000000", name: "ghost", isWavelength: false });

    const env = makeEnv({
      fetch: async (_url, init) => {
        assert.equal(readAction(init), "DescribeInstances");
        return makeXmlResponse(SAMPLE_INSTANCES_XML);
      },
    });

    const machines = await listMachines(db);
    const merged = await mergeMachineStates(env, machines);
    assert.equal(merged.length, 2);

    // 名稱為空時以 AWS Name 標籤補上
    assert.equal(merged[0].name, "web-1");
    assert.equal(merged[0].state, "running");
    assert.equal(merged[0].publicIpAddress, "203.0.113.10");

    // 回應中缺席的執行個體標示「未找到」
    assert.equal(merged[1].state, STATE_NOT_FOUND);
  });

  it("地區查詢失敗時該地區全部標示「查詢失敗」，其他地區不受影響", async () => {
    const db = createDb();
    await createMachine(db, { region: "us-east-1", instanceId: "i-0abc123def4567890", name: "a", isWavelength: false });
    await createMachine(db, { region: "ap-northeast-1", instanceId: "i-0wl1111111111111", name: "b", isWavelength: true });

    const env = makeEnv({
      fetch: async (url, _init) => {
        if (String(url).includes("ap-northeast-1")) {
          throw new Error("network unreachable");
        }
        return makeXmlResponse(SAMPLE_INSTANCES_XML);
      },
    });

    const machines = await listMachines(db);
    const merged = await mergeMachineStates(env, machines);
    const failed = merged.find((m) => m.region === "ap-northeast-1");
    const ok = merged.find((m) => m.region === "us-east-1");
    assert.equal(failed.state, STATE_QUERY_FAILED);
    assert.equal(ok.state, "running");
  });
});

// ── performPowerAction ──────────────────────────────────────

describe("performPowerAction", () => {
  const machine = { region: "us-east-1", instanceId: "i-0abc123def4567890" };

  it("start 送出 StartInstances 並帶 InstanceId.1", async () => {
    const calls = [];
    const env = makeEnv({
      fetch: async (_url, init) => {
        calls.push({ action: readAction(init), instanceId: new URLSearchParams(init.body).get("InstanceId.1") });
        return makeXmlResponse("<StartInstancesResponse/>");
      },
    });
    const result = await performPowerAction(env, machine, "start");
    assert.deepEqual(result, { ok: true, action: "start" });
    assert.equal(calls[0].action, "StartInstances");
    assert.equal(calls[0].instanceId, machine.instanceId);
  });

  it("stop 送出 StopInstances", async () => {
    const env = makeEnv({
      fetch: async (_url, init) => {
        assert.equal(readAction(init), "StopInstances");
        return makeXmlResponse("<StopInstancesResponse/>");
      },
    });
    const result = await performPowerAction(env, machine, "stop");
    assert.deepEqual(result, { ok: true, action: "stop" });
  });

  it("start/stop 以外的動作一律拒絕且不發出 AWS 請求", async () => {
    let called = false;
    const env = makeEnv({
      fetch: async () => {
        called = true;
        return makeXmlResponse("");
      },
    });
    await assert.rejects(() => performPowerAction(env, machine, "terminate"), /Unsupported action/);
    await assert.rejects(() => performPowerAction(env, machine, "reboot"), /Unsupported action/);
    assert.equal(called, false);
  });

  it("AWS 回應錯誤時拋出 AwsRequestError", async () => {
    const env = makeEnv({
      fetch: async () =>
        makeXmlResponse(
          `<Response><Errors><Error><Code>UnauthorizedOperation</Code><Message>denied</Message></Error></Errors></Response>`,
          403,
        ),
    });
    await assert.rejects(
      () => performPowerAction(env, machine, "start"),
      (error) => error.name === "AwsRequestError" && error.code === "UnauthorizedOperation",
    );
  });
});

// ── 操作日誌整合 ────────────────────────────────────────────

describe("電源操作日誌", () => {
  it("成功與失敗的操作皆寫入日誌", async () => {
    const db = createDb();
    await appendOperationLog(db, { action: "start", region: "us-east-1", instanceId: "i-1", status: "success" });
    await appendOperationLog(db, { action: "stop", region: "us-east-1", instanceId: "i-1", status: "failure", detail: "throttled" });

    const logs = await listOperationLogs(db, { action: "start" });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, "success");

    const failures = await listOperationLogs(db, { status: "failure" });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].detail, "throttled");
  });
});
