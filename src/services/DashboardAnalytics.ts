// ==========================================================
// Shared dashboard analytics — extract + aggregate logs
// รองรับทั้ง Workers Logpush และ format อื่นๆ
// ==========================================================

export interface ExtractedLog {
  rawUrl:       string;
  path:         string;
  status:       number;
  time:         number | string;
  rayId:        string;
  method:       string;
  latency:      number;
  ip:           string;
  errorMessage: string;
}

export interface DashboardResult {
  summary: {
    total_requests:  number;
    errors:          number;
    avg_response_ms: number;
    p95_response_ms: number;
    p99_response_ms: number;
    top_api:         [string, number][];
    slowest_api:     { endpoint: string; avg_ms: number; max_ms: number; count: number }[];
    traffic:         number[];
  };
  errors: any[];
  topIPs: [string, number][];
}

// ==========================================================
// Extract fields รองรับหลาย log format
// ==========================================================

export function extractFields(log: any): ExtractedLog {

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

  // ดึง error message จาก Exceptions หรือ Logs ของ Workers trace
  const exceptions: any[]  = log?.Exceptions || [];
  const logMessages: any[] = log?.Logs       || [];
  const errorMessage =
    exceptions.length > 0
      ? exceptions.map((e: any) => e?.Message || e?.name || JSON.stringify(e)).join(", ")
      : logMessages
          .filter((l: any) => l?.Level === "error" || l?.Level === "warn")
          .map((l: any) => (Array.isArray(l?.Message) ? l.Message.join(" ") : l?.Message))
          .join(", ") || "";

  // Parse path — รองรับทั้ง full URL และ path-only
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

  return { rawUrl, path, status, time, rayId, method, latency, ip, errorMessage };
}

// ==========================================================
// Analyze logs ครั้งเดียว return ครบทุกอย่าง
// ==========================================================

export function analyzeLogs(logs: any[]): DashboardResult {

  const endpointCount:   Record<string, number>   = {};
  const endpointLatency: Record<string, number[]> = {};
  const recent_errors:   any[]                    = [];
  const hourlyCount:     Record<number, number>   = {};
  const latencies:       number[]                 = [];
  const ipCount:         Record<string, number>   = {};

  let total_requests = 0;
  let errors         = 0;

  for (const raw of logs) {

    const log = extractFields(raw);

    // Skip log entries ที่ไม่มีข้อมูลสำคัญ
    if (!log.rawUrl && !log.rayId) continue;

    // Ignore dashboard routes
    const ignorePaths = ["/dashboard", "/api/dashboard"];
    if (ignorePaths.some(p => log.path.startsWith(p))) continue;

    total_requests++;
    latencies.push(log.latency);

    // Count IP
    ipCount[log.ip] = (ipCount[log.ip] || 0) + 1;

    // Count method + path
    const methodPath = `${log.method.toUpperCase()} ${log.path}`;
    endpointCount[methodPath]   = (endpointCount[methodPath]   || 0) + 1;
    endpointLatency[methodPath] = endpointLatency[methodPath]  || [];
    endpointLatency[methodPath].push(log.latency);

    // Errors — นับทุก status >= 400
    if (log.status >= 400) {
      errors++;
      recent_errors.push({
        time:    log.time,
        ip:      log.ip,
        url:     log.path,
        status:  log.status,
        rayId:   log.rayId,
        method:  log.method.toUpperCase(),
        message: log.errorMessage || "",
      });
    }

    // Traffic hourly — นับเฉพาะวันนี้ เวลาไทย UTC+7
    const ts = typeof log.time === "number" ? log.time : parseInt(log.time as string);
    const TZ_OFFSET_MS = 7 * 60 * 60 * 1000;
    const tsLocal  = new Date(ts + TZ_OFFSET_MS);
    const nowLocal = new Date(Date.now() + TZ_OFFSET_MS);
    const isToday =
      tsLocal.getUTCFullYear() === nowLocal.getUTCFullYear() &&
      tsLocal.getUTCMonth()    === nowLocal.getUTCMonth()    &&
      tsLocal.getUTCDate()     === nowLocal.getUTCDate();

    if (isToday) {
      const hour = tsLocal.getUTCHours();
      hourlyCount[hour] = (hourlyCount[hour] || 0) + 1;
    }
  }

  // ==========================================================
  // Aggregate
  // ==========================================================

  const top_api = Object.entries(endpointCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);

  const slowest_api = Object.entries(endpointLatency)
    .map(([endpoint, lats]) => {
      const sum = lats.reduce((s, v) => s + v, 0);
      const avg = Math.round(sum / lats.length);
      const max = lats.reduce((m, v) => v > m ? v : m, 0);
      return { endpoint, avg_ms: avg, max_ms: max, count: lats.length };
    })
    .filter(e => e.count >= 2)
    .sort((a, b) => b.avg_ms - a.avg_ms)
    .slice(0, 5);

  latencies.sort((a, b) => a - b);

  const avg_response_ms = latencies.length
    ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length)
    : 0;

  const p95_response_ms = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
  const p99_response_ms = latencies[Math.floor(latencies.length * 0.99)] ?? 0;

  const traffic = Array.from({ length: 24 }, (_, i) => hourlyCount[i] || 0);

  const topIPs = Object.entries(ipCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10) as [string, number][];

  console.log("[DashboardAnalytics] logs:", logs.length, "| counted:", total_requests, "| errors:", errors);

  return {
    summary: {
      total_requests,
      errors,
      avg_response_ms,
      p95_response_ms,
      p99_response_ms,
      top_api,
      slowest_api,
      traffic,
    },
    errors:  recent_errors.slice(-20).reverse(),
    topIPs,
  };
}
