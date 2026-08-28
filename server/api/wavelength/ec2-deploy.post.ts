// POST /api/wavelength/ec2-deploy：以 SSE 串流部署一般區域 EC2
// （作為 Wavelength 執行個體的對外跳板）。事件序列與 deploy 相同；
// 操作日誌 action: deploy_regional。
import { appendOperationLog } from "../../utils/db.js";
import { registerDeploymentMachines } from "../../utils/deployment-registration.js";
import { summarizeDeployResult } from "../../utils/deploy-log.js";
import { errorResponse, jsonResponse, readJsonBody, sseResponse } from "../../utils/http.js";
import { deployRegionalEc2Instance, toHttpError } from "../../utils/wavelength.js";
import { resolveAwsAccount } from "../../utils/aws-account.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  const body = await readJsonBody(event);
  if (!body || typeof body !== "object") {
    return errorResponse(400, "請求內容無效。");
  }

  const regionValidation = validateInput(body.region, "region", "地區");
  if (!regionValidation.valid) {
    return errorResponse(400, regionValidation.error);
  }
  const vpcValidation = validateInput(body.vpc_id, "vpcId", "VPC ID");
  if (!vpcValidation.valid) {
    return errorResponse(400, vpcValidation.error);
  }
  const osValidation = validateInput(body.os, "os", "作業系統");
  if (!osValidation.valid) {
    return errorResponse(400, osValidation.error);
  }
  let accountContext;
  try {
    accountContext = await resolveAwsAccount(env, body.account_id);
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse(httpError.body, { status: httpError.status });
  }
  const { account, awsEnv } = accountContext;

  return sseResponse(async (emit) => {
    try {
      const result = await deployRegionalEc2Instance(awsEnv, body, (stage, details = {}) => {
        emit("progress", { stage, ...details });
      });
      const management = await registerDeploymentMachines(env.DB, "regional", body.region, result, account.id);
      const response = { ...result, management };
      try {
        await appendOperationLog(env.DB, {
          action: "deploy_regional",
          region: body.region,
          instanceId: result.instance_id,
          status: "success",
          detail: summarizeDeployResult(response),
          awsAccountId: account.id,
        });
      } catch {
        // 日誌寫入失敗不影響成功結果
      }
      emit("result", response);
    } catch (error) {
      const httpError = toHttpError(error);
      try {
        await appendOperationLog(env.DB, {
          action: "deploy_regional",
          region: body.region,
          instanceId: null,
          status: "failure",
          detail: httpError.body?.error || String(error),
          awsAccountId: account.id,
        });
      } catch {
        // 日誌寫入失敗不影響錯誤事件
      }
      emit("error", httpError.body);
    }
  });
});
