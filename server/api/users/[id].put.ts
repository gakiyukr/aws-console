import { getUserById, listUsers, updateUser } from "../../utils/db.js";
import { errorResponse, jsonResponse, readJsonBody } from "../../utils/http.js";
import { hashPassword } from "../../utils/password.js";

export default defineEventHandler(async (event) => {
  const db = event.context.cloudflare?.env.DB;
  const id = Number(getRouterParam(event, "id"));
  const existing = Number.isSafeInteger(id) && id > 0 ? await getUserById(db, id) : null;
  if (!existing)
    return errorResponse(404, "使用者不存在");
  const body = await readJsonBody(event);
  const username = typeof body?.username === "string" ? body.username.trim() : existing.username;
  if (!/^[\w.-]{3,64}$/.test(username))
    return errorResponse(400, "使用者名稱須為 3 至 64 個英數字或 ._- 字元");
  const enabled = body?.enabled ?? existing.enabled;
  if (!enabled) {
    const enabledUsers = (await listUsers(db)).filter(user => user.enabled);
    if (enabledUsers.length <= 1 && enabledUsers[0]?.id === id)
      return errorResponse(409, "至少必須保留一個啟用的管理者");
  }
  try {
    const password = body?.password
      ? await hashPassword(body.password)
      : { passwordHash: existing.passwordHash, passwordSalt: existing.passwordSalt, passwordIterations: existing.passwordIterations };
    const user = await updateUser(db, id, {
      username,
      ...password,
      role: "admin",
      enabled,
      invalidateSessions: Boolean(body?.password) || enabled !== existing.enabled,
    });
    return jsonResponse({ user: { id: user.id, username: user.username, role: user.role, enabled: user.enabled } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "使用者更新失敗";
    return errorResponse(message.includes("UNIQUE") ? 409 : 400, message.includes("UNIQUE") ? "使用者名稱已存在" : message);
  }
});
