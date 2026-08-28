import { encryptAwsCredentials } from "../../utils/credential-crypto.js";
import { getAwsAccountById, updateAwsAccount } from "../../utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "../../utils/http.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  const id = Number(getRouterParam(event, "id"));
  const existing = Number.isSafeInteger(id) && id > 0 ? await getAwsAccountById(env.DB, id) : null;
  if (!existing)
    return errorResponse(404, "AWS 帳號不存在");
  const body = await readJsonBody(event);
  const name = typeof body?.name === "string" ? body.name.trim() : existing.name;
  if (!name || name.length > 80)
    return errorResponse(400, "帳號名稱必須為 1 至 80 個字元");
  const enabled = body?.enabled ?? existing.enabled;
  const isDefault = body?.isDefault ?? existing.isDefault;
  if (isDefault && !enabled)
    return errorResponse(400, "預設 AWS 帳號必須保持啟用");
  if (existing.isDefault && !isDefault)
    return errorResponse(409, "請先將另一個 AWS 帳號設為預設");

  try {
    const encrypted = body?.accessKeyId || body?.secretAccessKey
      ? await encryptAwsCredentials({
          accessKeyId: body.accessKeyId,
          secretAccessKey: body.secretAccessKey,
          sessionToken: body.sessionToken,
        }, env.CREDENTIAL_ENCRYPTION_KEY)
      : {
          credentialCiphertext: existing.credentialCiphertext,
          credentialIv: existing.credentialIv,
          accessKeyHint: existing.accessKeyHint,
          encryptionKeyVersion: existing.encryptionKeyVersion,
        };
    const account = await updateAwsAccount(env.DB, id, {
      name,
      ...encrypted,
      enabled,
      isDefault,
    });
    if (!account)
      return errorResponse(409, "AWS 帳號名稱已存在");
    const { credentialCiphertext, credentialIv, ...safe } = account;
    return jsonResponse({ account: safe });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AWS 帳號更新失敗";
    return errorResponse(message.includes("UNIQUE") ? 409 : 400, message.includes("UNIQUE") ? "AWS 帳號名稱已存在" : message);
  }
});
