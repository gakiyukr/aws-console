import { createUser } from "../../utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "../../utils/http.js";
import { hashPassword } from "../../utils/password.js";

export default defineEventHandler(async (event) => {
  const body = await readJsonBody(event);
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  if (!/^[\w.-]{3,64}$/.test(username))
    return errorResponse(400, "使用者名稱須為 3 至 64 個英數字或 ._- 字元");
  try {
    const user = await createUser(event.context.cloudflare?.env.DB, {
      username,
      ...await hashPassword(body?.password),
      role: "admin",
      enabled: body?.enabled !== false,
    });
    if (!user)
      return errorResponse(409, "使用者名稱已存在");
    return jsonResponse({ user: { id: user.id, username: user.username, role: user.role, enabled: user.enabled } }, { status: 201 });
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : "使用者建立失敗");
  }
});
