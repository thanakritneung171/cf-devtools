import { R2LogService } from "../services/R2LogService";

export async function dashboardHandler(request: Request, env: Env) {

  const r2   = new R2LogService(env.MY_BUCKET);
  const logs = await r2.readLogs();

  const endpointCount:   Record<string, number>   = {};
  const endpointLatency: Record<string, number[]> = {};
  const recent_errors:   any[]                    = [];
  const hourlyCount:     Record<number, number>   = {};
  const latencies:       number[]                 = [];

  let total_requests = 0;
  let errors         = 0;

  for (const log of logs) {

    // ==========================================================
    // Extract fields รองรับทั้ง Workers Logpush และ format อื่นๆ
    // Workers trace events: Event.Request.URL, Event.Response.Status
    // HTTP request log:     ClientRequestURI, EdgeResponseStatus
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

    const latency =
      log?.WallTimeMs                 ||
      log?.OriginResponseTime         ||
      log?.EdgeTimeToFirstByteMs      ||
      0;

    const ip =
      log?.ClientIP                   ||
      log?.ip                         ||
      log?.request?.cf?.connecting_ip ||
      "unknown";

    // ==========================================================
    // Parse path — รองรับทั้ง full URL และ path-only
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
        // path-only เช่น "/api/users?page=1" → ตัด query string ออก
        path = rawUrl.split("?")[0] || rawUrl;
      }
    }

    // ==========================================================
    // Skip log entries ที่ไม่มีข้อมูลสำคัญเลย
    // ==========================================================

    if (!rawUrl && !rayId) {
      continue;
    }

    // ==========================================================
    // Ignore dashboard routes
    // ==========================================================

    const ignorePaths = ["/dashboard", "/api/dashboard"];
    if (ignorePaths.some(p => path.startsWith(p))) {
      continue;
    }

    total_requests++;
    latencies.push(latency);

    // Count method + path
    const methodPath = `${method.toUpperCase()} ${path}`;
    endpointCount[methodPath]   = (endpointCount[methodPath]   || 0) + 1;
    endpointLatency[methodPath] = endpointLatency[methodPath]  || [];
    endpointLatency[methodPath].push(latency);

    // Errors
    if (status >= 400) {
      errors++;
      recent_errors.push({
        time,
        ip,
        url:    path,
        status,
        rayId,
        method: method.toUpperCase(),
      });
    }

    // Traffic hourly
    const ts   = typeof time === "number" ? time : parseInt(time);
    const hour = new Date(ts).getHours();
    hourlyCount[hour] = (hourlyCount[hour] || 0) + 1;

  }

  // ==========================================================
  // Aggregate results
  // ==========================================================

  const top_api = Object.entries(endpointCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);

  // slowest API — เรียงตาม avg latency จากมากไปน้อย top 5
  const slowest_api = Object.entries(endpointLatency)
    .map(([endpoint, lats]) => {
      const avg = Math.round(lats.reduce((s, v) => s + v, 0) / lats.length);
      const max = Math.max(...lats);
      return { endpoint, avg_ms: avg, max_ms: max, count: lats.length };
    })
    .filter(e => e.count >= 2)        // ต้องมีอย่างน้อย 2 ครั้งถึงนับ
    .sort((a, b) => b.avg_ms - a.avg_ms)
    .slice(0, 5);

  latencies.sort((a, b) => a - b);

  const avg_response_ms = latencies.length
    ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length)
    : 0;

  const p95_response_ms = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
  const p99_response_ms = latencies[Math.floor(latencies.length * 0.99)] ?? 0;

  const traffic = Array.from({ length: 24 }, (_, i) => hourlyCount[i] || 0);

  console.log("[Dashboard] logs:", logs.length, "| counted:", total_requests, "| errors:", errors);

  return Response.json({
    total_requests,
    errors,
    avg_response_ms,
    p95_response_ms,
    p99_response_ms,
    top_api,
    slowest_api,
    recent_errors:   recent_errors.slice(-20).reverse(),
    traffic,
  });

}