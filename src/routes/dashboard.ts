import { R2LogService } from "../services/R2LogService";

export async function dashboardHandler(request: Request, env: Env) {

  const r2 = new R2LogService(env.MY_BUCKET);
  const logs = await r2.readLogs();

  const ipCount: Record<string, number> = {};
  const endpointCount: Record<string, number> = {};
  const recent_errors: any[] = [];
  const hourlyCount: Record<number, number> = {};

  let total_requests = 0;
  let errors = 0;

  for (const log of logs) {

    // =========================
    // Extract fields from Logpush
    // =========================

    const url = log?.Event?.Request?.URL || "";
    const status = log?.Event?.Response?.Status || 200;
    const time = log?.EventTimestampMs || Date.now();

    let path = "unknown";

    try {
      path = new URL(url).pathname;
    } catch {}

    // =========================
    // Ignore dashboard calls
    // =========================

    if (path.startsWith("/dashboard")) continue;

    total_requests++;

    // =========================
    // IP (workers_trace_events ไม่มี IP)
    // =========================

    const ip = "unknown";

    ipCount[ip] = (ipCount[ip] || 0) + 1;

    // =========================
    // Count API
    // =========================

    endpointCount[path] = (endpointCount[path] || 0) + 1;

    // =========================
    // Errors
    // =========================

    if (status >= 400) {
      errors++;
      recent_errors.push({
        time,
        ip,
        url: path,
        status
      });
    }

    // =========================
    // Traffic graph
    // =========================

    const hour = new Date(time).getHours();
    hourlyCount[hour] = (hourlyCount[hour] || 0) + 1;

  }

  // =========================
  // Top API / Top IP
  // =========================

  const top_ip = Object.entries(ipCount)
    .sort((a,b)=>b[1]-a[1])
    .slice(0,10);

  const top_api = Object.entries(endpointCount)
    .sort((a,b)=>b[1]-a[1])
    .slice(0,30);

  // =========================
  // Graph data
  // =========================

  const traffic = Array.from({length:24},(_,i)=>hourlyCount[i] || 0);

  return Response.json({
    total_requests,
    errors,
    unique_ips: Object.keys(ipCount).length,
    top_api,
    top_ip,
    recent_errors: recent_errors.slice(-20).reverse(),
    traffic
  });

}