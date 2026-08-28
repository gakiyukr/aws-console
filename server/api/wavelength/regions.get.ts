// GET /api/wavelength/regions：列出已啟用且設有 Wavelength Zone 的地區。
import { jsonResponse } from "../../utils/http.js";
import { listWavelengthRegions, toHttpError } from "../../utils/wavelength.js";
import { resolveAwsAccount } from "../../utils/aws-account.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  try {
    const { awsEnv } = await resolveAwsAccount(env, getQuery(event).account_id);
    return jsonResponse({
      regions: await listWavelengthRegions(awsEnv),
    });
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
});
