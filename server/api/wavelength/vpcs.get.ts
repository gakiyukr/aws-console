// GET /api/wavelength/vpcs?region=…：列出指定地區可用的 VPC 選項。
import { errorResponse, jsonResponse } from "../../utils/http.js";
import { listVpcOptions, toHttpError } from "../../utils/wavelength.js";
import { validateInput } from "../../utils/validate.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  const region = String(getQuery(event).region ?? "");
  const validation = validateInput(region, "region", "地區");
  if (!validation.valid) {
    return errorResponse(400, validation.error);
  }

  try {
    return jsonResponse({
      region,
      vpcs: await listVpcOptions(env, region),
    });
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
});
