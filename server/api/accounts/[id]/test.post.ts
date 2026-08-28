import { resolveAwsAccount, toAwsAccountHttpError } from "../../../utils/aws-account.js";
import { ec2Query } from "../../../utils/aws-query.js";
import { markAwsAccountVerified } from "../../../utils/db.js";
import { jsonResponse } from "../../../utils/http.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  try {
    const { account, awsEnv } = await resolveAwsAccount(env, getRouterParam(event, "id"));
    await ec2Query("us-east-1", awsEnv, "DescribeRegions", { "AllRegions": false });
    await markAwsAccountVerified(env.DB, account.id);
    return jsonResponse({ ok: true, message: "AWS 憑證驗證成功" });
  } catch (error) {
    const httpError = toAwsAccountHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
});
