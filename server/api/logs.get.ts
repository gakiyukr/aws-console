// GET /api/logs：讀取機器操作與部署流程的稽核日誌。
// 可選 action、status 與 limit 篩選；結果已由認證中介層保護。
import { listOperationLogs } from "../utils/db.js";
import { errorResponse, jsonResponse } from "../utils/http.js";
import { validateInput } from "../utils/validate.js";

const LOG_STATUSES = new Set(["success", "failure"]);
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function parseLimit(value: unknown): number | null {
  if (value === undefined) {
    return DEFAULT_LIMIT;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return null;
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return null;
  }
  return Math.min(limit, MAX_LIMIT);
}

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  const query = getQuery(event);
  const action = typeof query.action === "string" ? query.action : undefined;
  const status = typeof query.status === "string" ? query.status : undefined;
  const awsAccountId = query.account_id === undefined ? undefined : Number(query.account_id);

  if (query.action !== undefined && action === undefined) {
    return errorResponse(400, "action 參數無效");
  }
  if (action !== undefined) {
    const validation = validateInput(action, undefined, "action");
    if (!validation.valid) {
      return errorResponse(400, validation.error);
    }
  }

  if (query.status !== undefined && status === undefined) {
    return errorResponse(400, "status 參數無效");
  }
  if (status !== undefined && !LOG_STATUSES.has(status)) {
    return errorResponse(400, "status 參數無效");
  }
  if (awsAccountId !== undefined && (!Number.isSafeInteger(awsAccountId) || awsAccountId <= 0)) {
    return errorResponse(400, "account_id 參數無效");
  }

  const limit = parseLimit(query.limit);
  if (limit === null) {
    return errorResponse(400, "limit 參數無效");
  }

  const logs = await listOperationLogs(env.DB, { action, status, awsAccountId, limit });
  return jsonResponse({ logs });
});
