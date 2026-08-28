import { deleteAwsAccount } from "../../utils/db.js";
import { errorResponse, jsonResponse } from "../../utils/http.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  const id = Number(getRouterParam(event, "id"));
  if (!Number.isSafeInteger(id) || id <= 0)
    return errorResponse(400, "AWS 帳號 ID 無效");
  const result = await deleteAwsAccount(env.DB, id);
  if (result.reason === "not_found")
    return errorResponse(404, "AWS 帳號不存在");
  if (result.reason === "in_use")
    return errorResponse(409, "此帳號仍有受管機器，請先移除或轉移機器");
  return jsonResponse({ ok: true });
});
