// POST /api/ssh-keys：新增機器登入公鑰。名稱走通用輸入驗證，
// 金鑰內容以 validateSshPublicKeyText 驗證格式（與部署解析共用同一規則）。
import { createSshPublicKey, listSshPublicKeys } from "../../utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "../../utils/http.js";
import { validateInput } from "../../utils/validate.js";
import { validateSshPublicKeyText } from "../../utils/wavelength.js";

// 公鑰庫容量上限，避免無限成長
const MAX_SSH_KEYS = 50;

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  const body = await readJsonBody(event);
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const labelValidation = validateInput(label, undefined, "公鑰名稱");
  if (!labelValidation.valid) {
    return errorResponse(400, labelValidation.error);
  }

  let keys;
  try {
    keys = validateSshPublicKeyText(typeof body?.publicKey === "string" ? body.publicKey : "");
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : "SSH 公鑰格式無效");
  }

  const existing = await listSshPublicKeys(env.DB);
  if (existing.length >= MAX_SSH_KEYS) {
    return errorResponse(400, `公鑰數量已達上限（${MAX_SSH_KEYS} 把），請先刪除不使用的金鑰`);
  }

  const created = await createSshPublicKey(env.DB, { label, publicKey: keys.join("\n") });
  if (!created) {
    return errorResponse(409, "此 SSH 公鑰已存在");
  }
  return jsonResponse({ id: created.id }, { status: 201 });
});
