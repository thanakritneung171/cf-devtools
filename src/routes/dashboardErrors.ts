import { R2LogService } from "../services/R2LogService";

export async function dashboardErrors(request: Request, env: Env) {

  const r2 = new R2LogService(env.MY_BUCKET);
  const logs = await r2.readLogs();

  const errors: any[] = [];

  for (const log of logs) {

    const status =
      log?.Status ||
      log?.status ||
      log?.Event?.Response?.Status ||
      200;

    if (status < 400) continue;

    const ip =
      log?.ClientIP ||
      log?.ip ||
      log?.request?.cf?.connecting_ip ||
      "unknown";

    const url =
      log?.URL ||
      log?.request?.url ||
      log?.Event?.Request?.URL ||
      "";

    const time =
      log?.Timestamp ||
      log?.time ||
      Date.now();

    errors.push({
      time,
      ip,
      url,
      status
    });

  }

  return Response.json(errors.slice(-20).reverse());

}