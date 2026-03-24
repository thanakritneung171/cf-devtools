import { R2LogService } from "../services/R2LogService";

export async function dashboardErrors(request: Request, env: Env) {

  const r2   = new R2LogService(env.MY_BUCKET);
  const logs = await r2.readLogs();

  const errors: any[] = [];

  for (const log of logs) {

    const rawUrl =
      log?.Event?.Request?.URL        ||
      log?.ClientRequestURI           ||
      log?.request?.url               ||
      log?.URL                        ||
      "";

    const status =
      log?.Event?.Response?.Status    ||
      log?.EdgeResponseStatus         ||
      log?.status                     ||
      log?.Status                     ||
      200;

    const time =
      log?.EventTimestampMs           ||
      log?.EdgeStartTimestamp         ||
      log?.Timestamp                  ||
      log?.timestamp                  ||
      Date.now();

    const rayId =
      log?.Event?.RayID               ||
      log?.RayID                      ||
      log?.rayId                      ||
      "";

    const method =
      log?.Event?.Request?.Method     ||
      log?.ClientRequestMethod        ||
      log?.request?.method            ||
      log?.Method                     ||
      "GET";

    const ip =
      log?.ClientIP                   ||
      log?.ip                         ||
      log?.request?.cf?.connecting_ip ||
      "unknown";

    // ดึง error message จาก Exceptions และ Logs (level error/warn)
    const exceptions: any[]  = log?.Exceptions || [];
    const logMessages: any[] = log?.Logs        || [];

    const errorMessage =
      exceptions.length > 0
        ? exceptions
            .map((e: any) => e?.Message || e?.name || JSON.stringify(e))
            .join(", ")
        : logMessages
            .filter((l: any) => l?.Level === "error" || l?.Level === "warn")
            .map((l: any) =>
              Array.isArray(l?.Message) ? l.Message.join(" ") : (l?.Message || "")
            )
            .join(", ") || "";

    if (status < 400) continue;
    if (!rawUrl && !rayId) continue;

    let path = "unknown";
    if (rawUrl) {
      if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
        try { path = new URL(rawUrl).pathname; } catch { path = rawUrl; }
      } else {
        path = rawUrl.split("?")[0] || rawUrl;
      }
    }

    errors.push({
      time,
      ip,
      url:     path,
      status,
      rayId,
      method:  method.toUpperCase(),
      message: errorMessage || "",
    });

  }

  return Response.json(errors.slice(-20).reverse());

}