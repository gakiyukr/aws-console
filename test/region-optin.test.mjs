// wavelength.js 開通區域功能的測試：listAccountRegions（不過濾 opt-in
// 狀態）與 enableAwsRegion（EC2 EnableRegion 一律送至 us-east-1），
// AWS 互動以 env.__testHooks.fetch 注入 fake fetch。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { enableAwsRegion, listAccountRegions } from "../server/utils/wavelength.js";

// ── 測試輔助 ────────────────────────────────────────────────

/** 建立含 AWS 憑證與測試鉤子的 env。 */
function makeEnv(fetchImpl) {
  return {
    AWS_ACCESS_KEY_ID: "key",
    AWS_SECRET_ACCESS_KEY: "secret",
    __testHooks: { fetch: fetchImpl },
  };
}

/** 自 Request init 取出 form-urlencoded 參數。 */
function readParams(init) {
  return new URLSearchParams(String(init.body));
}

/** 建立 AWS 形態的 XML 回應。 */
function makeXmlResponse(xml, status = 200) {
  return new Response(xml, { status, headers: { "content-type": "text/xml" } });
}

/** 建立 AWS 錯誤 XML 回應。 */
function makeErrorResponse(code, message, status = 400) {
  return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
    <Response><Errors><Error><Code>${code}</Code><Message>${message}</Message></Error></Errors></Response>`, status);
}

// ── listAccountRegions ──────────────────────────────────────

describe("listAccountRegions", () => {
  it("回傳全部 Region 與 opt-in 狀態，未開通區域不被過濾", async () => {
    let requestedUrl = "";
    const env = makeEnv(async (url, init) => {
      requestedUrl = url;
      const params = readParams(init);
      assert.equal(params.get("Action"), "DescribeRegions");
      assert.equal(params.get("AllRegions"), "true");
      return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
        <DescribeRegionsResponse>
          <regionInfo>
            <item><regionName>us-east-1</regionName><optInStatus>opt-in-not-required</optInStatus></item>
            <item><regionName>ap-east-1</regionName><optInStatus>not-opted-in</optInStatus></item>
            <item><regionName>me-central-1</regionName><optInStatus>opted-in</optInStatus></item>
          </regionInfo>
        </DescribeRegionsResponse>`);
    });

    const regions = await listAccountRegions(env);

    assert.match(requestedUrl, /ec2\.us-east-1\.amazonaws\.com/);
    assert.deepEqual(regions, [
      { region: "ap-east-1", optInStatus: "not-opted-in" },
      { region: "me-central-1", optInStatus: "opted-in" },
      { region: "us-east-1", optInStatus: "opt-in-not-required" },
    ]);
  });
});

// ── enableAwsRegion ─────────────────────────────────────────

describe("enableAwsRegion", () => {
  it("送 EnableRegion 至 us-east-1 並帶上 RegionName", async () => {
    let requestedUrl = "";
    const env = makeEnv(async (url, init) => {
      requestedUrl = url;
      const params = readParams(init);
      assert.equal(params.get("Action"), "EnableRegion");
      assert.equal(params.get("RegionName"), "ap-east-1");
      return makeXmlResponse(`<EnableRegionResponse><requestId>req-1</requestId></EnableRegionResponse>`);
    });

    await enableAwsRegion(env, "ap-east-1");

    assert.match(requestedUrl, /ec2\.us-east-1\.amazonaws\.com/);
  });

  it("AWS 拒絕時拋出含狀態碼與訊息的 AwsRequestError", async () => {
    const env = makeEnv(async () =>
      makeErrorResponse("UnauthorizedOperation", "You are not authorized to perform this operation.", 403));

    await assert.rejects(
      () => enableAwsRegion(env, "ap-east-1"),
      (error) => {
        assert.equal(error.name, "AwsRequestError");
        assert.equal(error.statusCode, 403);
        assert.match(error.message, /not authorized/);
        return true;
      },
    );
  });
});
