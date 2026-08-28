import { encryptAwsCredentials } from "../../utils/credential-crypto.js";
import { createAwsAccount } from "../../utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "../../utils/http.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  if (!env?.CREDENTIAL_ENCRYPTION_KEY)
    return errorResponse(503, "伺服器尚未設定憑證加密主金鑰");
  const body = await readJsonBody(event);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 80)
    return errorResponse(400, "帳號名稱必須為 1 至 80 個字元");
  if (body.enabled === false && body.isDefault === true)
    return errorResponse(400, "預設 AWS 帳號必須保持啟用");

  try {
    const encrypted = await encryptAwsCredentials({
      accessKeyId: body.accessKeyId,
      secretAccessKey: body.secretAccessKey,
      sessionToken: body.sessionToken,
    }, env.CREDENTIAL_ENCRYPTION_KEY);
    const account = await createAwsAccount(env.DB, {
      name,
      ...encrypted,
      enabled: body.enabled !== false,
      isDefault: body.isDefault === true,
    });
    if (!account)
      return errorResponse(409, "AWS 帳號名稱已存在");
    const { credentialCiphertext, credentialIv, ...safe } = account;
    return jsonResponse({ account: safe }, { status: 201 });
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : "AWS 帳號建立失敗");
  }
});
