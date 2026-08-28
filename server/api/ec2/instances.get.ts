// GET /api/ec2/instances：列出所選 AWS 帳號與 Region 內的全部 EC2 執行個體，
// 供「新增機器」挑選既有執行個體，取代手動輸入執行個體 ID。
import { resolveAwsAccount } from "../../utils/aws-account.js";
import { errorResponse, jsonResponse } from "../../utils/http.js";
import { listRegionInstances } from "../../utils/power.js";
import { toHttpError } from "../../utils/wavelength.js";
import { validateInput } from "../../utils/validate.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  const query = getQuery(event);
  const region = String(query.region ?? "");
  const validation = validateInput(region, "region", "地區");
  if (!validation.valid)
    return errorResponse(400, validation.error);

  try {
    const { awsEnv } = await resolveAwsAccount(env, query.account_id);
    return jsonResponse({ region, instances: await listRegionInstances(awsEnv, region) });
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
});
