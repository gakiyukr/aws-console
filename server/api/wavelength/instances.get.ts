// GET /api/wavelength/instances?region=…&zone=…&vpc_id=…：
// 列出指定 VPC 內既有的 Wavelength 執行個體（供 forwarder 流程選擇目標）。
import { errorResponse, jsonResponse } from "../../utils/http.js";
import { listExistingWavelengthInstances, toHttpError } from "../../utils/wavelength.js";
import { validateInput } from "../../utils/validate.js";
import { resolveAwsAccount } from "../../utils/aws-account.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  const query = getQuery(event);
  const region = String(query.region ?? "");
  const zone = String(query.zone ?? "");
  const vpcId = String(query.vpc_id ?? "");

  const regionValidation = validateInput(region, "region", "地區");
  if (!regionValidation.valid) {
    return errorResponse(400, regionValidation.error);
  }
  const zoneValidation = validateInput(zone, "zone", "Zone ID");
  if (!zoneValidation.valid) {
    return errorResponse(400, zoneValidation.error);
  }
  const vpcValidation = validateInput(vpcId, "vpcId", "VPC ID");
  if (!vpcValidation.valid) {
    return errorResponse(400, vpcValidation.error);
  }

  try {
    const { awsEnv } = await resolveAwsAccount(env, query.account_id);
    // 測試注入點：與舊版 worker 相同，允許以樁替換清單函式
    const listFn = env.__testHooks?.listExistingWavelengthInstances || listExistingWavelengthInstances;
    return jsonResponse({
      region,
      zone,
      vpc_id: vpcId,
      instances: await listFn(awsEnv, { region, zone, vpc_id: vpcId }),
    });
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
});
