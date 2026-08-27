// validate.js 的單元測試：正則全集（region/zone/vpcId/instanceType/
// instanceId/os/subnetId/securityGroupId）與基本字串檢查。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateInput } from "../server/utils/validate.js";

describe("validateInput", () => {
  it("region：合法地區通過、非法格式拒絕", () => {
    assert.equal(validateInput("us-east-1", "region", "地區").valid, true);
    assert.equal(validateInput("us-gov-west-1", "region", "地區").valid, true);
    assert.equal(validateInput("ap-northeast-1", "region", "地區").valid, true);
    assert.equal(validateInput("US-EAST-1", "region", "地區").valid, false);
    assert.equal(validateInput("us_east_1", "region", "地區").valid, false);
    assert.equal(validateInput("us-east-", "region", "地區").valid, false);
  });

  it("zone：Wavelength Zone 命名通過", () => {
    assert.equal(
      validateInput("ap-northeast-1-wl1-kix-wlz-1", "zone", "Zone").valid,
      true,
    );
    assert.equal(
      validateInput("us-east-1-wl1-was-wlz-1", "zone", "Zone").valid,
      true,
    );
    assert.equal(validateInput("us-east-1", "zone", "Zone").valid, false);
    assert.equal(validateInput("ap-northeast-1-wl1-kix", "zone", "Zone").valid, false);
  });

  it("vpcId：短 ID 與正式 17 位 ID 皆通過", () => {
    assert.equal(validateInput("vpc-123", "vpcId", "VPC").valid, true);
    assert.equal(validateInput("vpc-0123456789abcdef0", "vpcId", "VPC").valid, true);
    assert.equal(validateInput("subnet-123", "vpcId", "VPC").valid, false);
    assert.equal(validateInput("vpc-", "vpcId", "VPC").valid, false);
  });

  it("instanceType：常見型別通過", () => {
    assert.equal(validateInput("t3.nano", "instanceType", "型別").valid, true);
    assert.equal(validateInput("g.r5.2xlarge", "instanceType", "型別").valid, false);
    // Wavelength 常見的 c5.xlarge / r5.2xlarge 形態
    assert.equal(validateInput("r5.2xlarge", "instanceType", "型別").valid, true);
    assert.equal(validateInput("xlarge", "instanceType", "型別").valid, false);
  });

  it("instanceId：短 ID 與正式 ID 皆通過", () => {
    assert.equal(validateInput("i-123", "instanceId", "執行個體").valid, true);
    assert.equal(validateInput("i-0123456789abcdef0", "instanceId", "執行個體").valid, true);
    assert.equal(validateInput("i-wl-existing", "instanceId", "執行個體").valid, true);
    assert.equal(validateInput("inst-123", "instanceId", "執行個體").valid, false);
  });

  it("os：debian 代號通過、路徑字元拒絕", () => {
    assert.equal(validateInput("debian-12", "os", "OS").valid, true);
    assert.equal(validateInput("debian_13", "os", "OS").valid, true);
    assert.equal(validateInput("../etc", "os", "OS").valid, false);
    assert.equal(validateInput("Debian 12", "os", "OS").valid, false);
  });

  it("subnetId 與 securityGroupId：AWS ID 形態", () => {
    assert.equal(validateInput("subnet-0123456789abcdef0", "subnetId", "Subnet").valid, true);
    assert.equal(validateInput("sg-0123456789abcdef0", "securityGroupId", "SG").valid, true);
    assert.equal(validateInput("vpc-0123456789abcdef0", "subnetId", "Subnet").valid, false);
  });

  it("非字串、空字串、超長字串皆拒絕", () => {
    assert.equal(validateInput(123, "region", "地區").valid, false);
    assert.equal(validateInput(null, "region", "地區").valid, false);
    assert.equal(validateInput("", "region", "地區").valid, false);
    assert.equal(validateInput("a".repeat(257), "region", "地區").valid, false);
  });

  it("無正則的類別僅做基本檢查（名稱欄位）", () => {
    assert.equal(validateInput("我的機器", "name", "名稱").valid, true);
    assert.equal(validateInput("", "name", "名稱").valid, false);
  });

  it("錯誤訊息含欄位名稱（繁體中文）", () => {
    const result = validateInput("BAD", "region", "地區");
    assert.equal(result.valid, false);
    assert.ok(result.error.includes("地區"));
  });
});
