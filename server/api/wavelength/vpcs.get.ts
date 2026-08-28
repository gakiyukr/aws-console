// GET /api/wavelength/vpcs?region=…：列出指定地區可用的 VPC 選項。
import { errorResponse, jsonResponse } from "../../utils/http.js";
import { listVpcOptions, toHttpError } from "../../utils/wavelength.js";
import { validateInput } from "../../utils/validate.js";
import { resolveAwsAccount } from "../../utils/aws-account.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  const query = getQuery(event);
  const region = String(query.region ?? "");
  const validation = validateInput(region, "region", "地區");
  if (!validation.valid) {
    return errorResponse(400, validation.error);
  }

  try {
    const { awsEnv } = await resolveAwsAccount(env, query.account_id);
    return jsonResponse({
      region,
      vpcs: await listVpcOptions(awsEnv, region),
    });
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
});
