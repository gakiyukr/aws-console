import { listUsers } from "../../utils/db.js";
import { jsonResponse } from "../../utils/http.js";

function publicUser(user: { id: number, username: string, role: string, enabled: boolean, authVersion: number, createdAt: string, updatedAt: string }) {
  return { id: user.id, username: user.username, role: user.role, enabled: user.enabled, authVersion: user.authVersion, createdAt: user.createdAt, updatedAt: user.updatedAt };
}

export default defineEventHandler(async (event) => {
  const users = await listUsers(event.context.cloudflare?.env.DB);
  return jsonResponse({ users: users.map(publicUser) });
});
