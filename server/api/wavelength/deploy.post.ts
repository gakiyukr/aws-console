// POST /api/wavelength/deploy：以 SSE 串流部署 Wavelength 執行個體。
// 事件序列：progress…（各階段）→ result（成功）或 error（失敗）；
// sseResponse 已在 onStart 拋錯時自動轉為 error 事件，此處僅需
// 於 result/error 時寫入操作日誌（action: deploy_wavelength）。
import { appendOperationLog } from "../../utils/db.js";
import { registerDeploymentMachines } from "../../utils/deployment-registration.js";
import { summarizeDeployResult } from "../../utils/deploy-log.js";
import { errorResponse, readJsonBody, sseResponse } from "../../utils/http.js";
import { deployWavelengthInstance, toHttpError } from "../../utils/wavelength.js";

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
  const zoneValidation = validateInput(body.zone, "zone", "Zone ID");
  if (!zoneValidation.valid) {
    return errorResponse(400, zoneValidation.error);
  }
  const vpcValidation = validateInput(body.vpc_id, "vpcId", "VPC ID");
  if (!vpcValidation.valid) {
    return errorResponse(400, vpcValidation.error);
  }
  const instanceTypeValidation = validateInput(body.instance_type, "instanceType", "執行個體類型");
  if (!instanceTypeValidation.valid) {
    return errorResponse(400, instanceTypeValidation.error);
  }
  const osValidation = validateInput(body.os, "os", "作業系統");
  if (!osValidation.valid) {
    return errorResponse(400, osValidation.error);
  }

  return sseResponse(async (emit) => {
    try {
      const result = await deployWavelengthInstance(env, body, (stage, details = {}) => {
        emit("progress", { stage, ...details });
      });
      const management = await registerDeploymentMachines(env.DB, "wavelength", body.region, result);
      const response = { ...result, management };
      try {
        await appendOperationLog(env.DB, {
          action: "deploy_wavelength",
          region: body.region,
          instanceId: result.instance_id,
          status: "success",
          detail: summarizeDeployResult(response),
        });
      } catch {
        // 日誌寫入失敗不影響成功結果
      }
      emit("result", response);
    } catch (error) {
      const httpError = toHttpError(error);
      try {
        await appendOperationLog(env.DB, {
          action: "deploy_wavelength",
          region: body.region,
          instanceId: null,
          status: "failure",
          detail: httpError.body?.error || String(error),
        });
      } catch {
        // 日誌寫入失敗不影響錯誤事件
      }
      emit("error", httpError.body);
    }
  });
});
