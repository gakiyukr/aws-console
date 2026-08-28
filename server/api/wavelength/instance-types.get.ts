// GET /api/wavelength/instance-types?region=…&zone=…：
// 列出該 Zone 內可用的執行個體類型（依價位排序）。
import { errorResponse, jsonResponse } from "../../utils/http.js";
import { listWavelengthInstanceTypes, toHttpError } from "../../utils/wavelength.js";
import { validateInput } from "../../utils/validate.js";
import { resolveAwsAccount } from "../../utils/aws-account.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  const query = getQuery(event);
  const region = String(query.region ?? "");
  const zone = String(query.zone ?? "");

  const regionValidation = validateInput(region, "region", "地區");
  if (!regionValidation.valid) {
    return errorResponse(400, regionValidation.error);
  }
  const zoneValidation = validateInput(zone, "zone", "Zone ID");
  if (!zoneValidation.valid) {
    return errorResponse(400, zoneValidation.error);
  }

  try {
    const { awsEnv } = await resolveAwsAccount(env, query.account_id);
    return jsonResponse({
      region,
      zone,
      instance_types: await listWavelengthInstanceTypes(awsEnv, region, zone),
    });
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
});
