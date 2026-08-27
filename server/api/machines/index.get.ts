// GET /api/machines：合併 D1 機器清單與 DescribeInstances 即時狀態。
// 地區查詢失敗不影響整體回應（該地區列標示「查詢失敗」），
// 因此本端點在 AWS 異常時仍能回 200，讓前端可管理清單本身。
import { listMachines } from "../../utils/db.js";
import { jsonResponse } from "../../utils/http.js";
import { mergeMachineStates } from "../../utils/power.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  const machines = await listMachines(env.DB);
  return jsonResponse(await mergeMachineStates(env, machines));
});
