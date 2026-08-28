// GET /api/machines：合併 D1 機器清單與 DescribeInstances 即時狀態。
// 地區查詢失敗不影響整體回應（該地區列標示「查詢失敗」），
// 因此本端點在 AWS 異常時仍能回 200，讓前端可管理清單本身。
import { listMachines } from "../../utils/db.js";
import { jsonResponse } from "../../utils/http.js";
import { mergeMachineStates } from "../../utils/power.js";
import { resolveAwsAccount } from "../../utils/aws-account.js";

export default defineEventHandler(async (event) => {
  const env = event.context.cloudflare?.env;
  const machines = await listMachines(env.DB);
  const groups = new Map<number | null, typeof machines>();
  for (const machine of machines) {
    const key = machine.awsAccountId || null;
    groups.set(key, [...(groups.get(key) || []), machine]);
  }
  const rows = new Map<number, any>();
  await Promise.all([...groups.entries()].map(async ([accountId, accountMachines]) => {
    try {
      const { account, awsEnv } = await resolveAwsAccount(env, accountId);
      for (const machine of await mergeMachineStates(awsEnv, accountMachines)) {
        rows.set(machine.id, { ...machine, awsAccountName: account.name });
      }
    } catch {
      for (const machine of accountMachines) {
        rows.set(machine.id, {
          ...machine,
          awsAccountName: null,
          state: "查詢失敗",
          publicDnsName: "查詢失敗",
          publicIpAddress: "查詢失敗",
        });
      }
    }
  }));
  return jsonResponse(machines.map(machine => rows.get(machine.id)));
});
