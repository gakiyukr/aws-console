import { listAwsAccounts } from "../../utils/db.js";
import { jsonResponse } from "../../utils/http.js";

function publicAccount(account) {
  const { credentialCiphertext, credentialIv, ...safe } = account;
  return safe;
}

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  const accounts = await listAwsAccounts(env.DB);
  return jsonResponse({ accounts: accounts.map(publicAccount) });
});
