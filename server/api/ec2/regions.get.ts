// GET /api/ec2/regions：列出所選 AWS 帳號已啟用的全部 Region。
import { resolveAwsAccount } from "../../utils/aws-account.js";
import { jsonResponse } from "../../utils/http.js";
import { listEc2Regions, toHttpError } from "../../utils/wavelength.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  try {
    const { awsEnv } = await resolveAwsAccount(env, getQuery(event).account_id);
    return jsonResponse({ regions: await listEc2Regions(awsEnv) });
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
});
