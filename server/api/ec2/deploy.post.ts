// POST /api/ec2/deploy：以 SSE 串流部署一般區域 EC2。
import { resolveAwsAccount } from "../../utils/aws-account.js";
import { appendOperationLog } from "../../utils/db.js";
import { registerDeploymentMachines } from "../../utils/deployment-registration.js";
import { summarizeDeployResult } from "../../utils/deploy-log.js";
import { errorResponse, jsonResponse, readJsonBody, sseResponse } from "../../utils/http.js";
import { validateInput } from "../../utils/validate.js";
import { deployRegionalEc2Instance, toHttpError } from "../../utils/wavelength.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  const body = await readJsonBody(event);
  if (!body || typeof body !== "object")
    return errorResponse(400, "請求內容無效。");

  for (const [value, type, label] of [
    [body.region, "region", "地區"],
    [body.vpc_id, "vpcId", "VPC ID"],
    [body.os, "os", "作業系統"],
  ]) {
    const validation = validateInput(value, type, label);
    if (!validation.valid)
      return errorResponse(400, validation.error);
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
        // 稽核寫入失敗不可掩蓋 AWS 已完成的部署結果。
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
        // 稽核寫入失敗不影響錯誤事件。
      }
      emit("error", httpError.body);
    }
  });
});
