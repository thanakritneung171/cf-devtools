import { R2LogService } from "../services/R2LogService";

export async function dashboardErrors(request: Request, env: Env) {

  const r2   = new R2LogService(env.MY_BUCKET);
  const logs = await r2.readLogs();

  const errors: any[] = [];

  for (const log of logs) {

    // ==========================================================
    // Extract fields — รองรับทั้ง Workers Logpush และ format อื่นๆ
    // ==========================================================

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

    // Skip ถ้าไม่ใช่ error
    if (status < 400) continue;

    // Skip ถ้าไม่มีข้อมูล
    if (!rawUrl && !rayId) continue;

    // ==========================================================
    // Parse path
    // ==========================================================

    let path = "unknown";

    if (rawUrl) {
      if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
        try {
          path = new URL(rawUrl).pathname;
        } catch {
          path = rawUrl;
        }
      } else {
        path = rawUrl.split("?")[0] || rawUrl;
      }
    }

    errors.push({
      time,
      ip,
      url:    path,
      status,
      rayId,
      method: method.toUpperCase(),
    });

  }

  // เรียงจากใหม่ไปเก่า ส่งกลับ 20 รายการล่าสุด
  return Response.json(errors.slice(-20).reverse());

}