// GET /api/wavelength/regions：列出已啟用且設有 Wavelength Zone 的地區。
import { jsonResponse } from "../../utils/http.js";
import { listWavelengthRegions, toHttpError } from "../../utils/wavelength.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  try {
    return jsonResponse({
      regions: await listWavelengthRegions(env),
    });
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
});
