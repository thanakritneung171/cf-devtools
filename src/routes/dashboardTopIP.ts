import { R2LogService } from "../services/R2LogService";

export async function dashboardTopIP(request: Request, env: Env) {

  const r2 = new R2LogService(env.MY_BUCKET);
  const logs = await r2.readLogs();

  const ipCount: Record<string, number> = {};

  for (const log of logs) {

    const ip =
      log?.ClientIP ||
      log?.ip ||
      log?.request?.cf?.connecting_ip ||
      "unknown";

    ipCount[ip] = (ipCount[ip] || 0) + 1;

  }

  const top_ip = Object.entries(ipCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  return Response.json(top_ip);

}