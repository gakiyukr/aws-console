// POST /api/machines：新增機器至 D1 清單。
// 全欄位正則驗證；(region, instanceId) 重複時回 409。
import { createMachine } from "../../utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "../../utils/http.js";
import { validateInput } from "../../utils/validate.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  const body = await readJsonBody(event);
  if (!body || typeof body !== "object") {
    return errorResponse(400, "請求內容無效。");
  }

  const region = validateInput(body.region, "region", "地區");
  if (!region.valid) {
    return errorResponse(400, region.error);
  }
  const instanceId = validateInput(body.instanceId, "instanceId", "執行個體 ID");
  if (!instanceId.valid) {
    return errorResponse(400, instanceId.error);
  }
  const name = validateInput(body.name, undefined, "顯示名稱");
  if (!name.valid) {
    return errorResponse(400, name.error);
  }

  const created = await createMachine(env.DB, {
    region: body.region,
    instanceId: body.instanceId,
    name: body.name,
    isWavelength: Boolean(body.isWavelength),
  });
  if (!created) {
    return errorResponse(409, "此機器已在清單中。");
  }
  return jsonResponse({ ok: true, id: created.id }, { status: 201 });
});
