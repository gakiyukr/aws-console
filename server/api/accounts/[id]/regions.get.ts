// GET /api/accounts/:id/regions：列出 AWS 帳號的全部 Region 與 opt-in 狀態。
// 供帳號管理頁的「開通區域」對話框使用；結果不經 isRegionEnabled 過濾，
// 未開通的 opt-in 區域也會一併回傳（optInStatus=not-opted-in）。
import { resolveAwsAccount, toAwsAccountHttpError } from "../../../utils/aws-account.js";
import { jsonResponse } from "../../../utils/http.js";
import { listAccountRegions } from "../../../utils/wavelength.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  try {
    const { awsEnv } = await resolveAwsAccount(env, getRouterParam(event, "id"));
    return jsonResponse({ regions: await listAccountRegions(awsEnv) });
  } catch (error) {
    const httpError = toAwsAccountHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
});
