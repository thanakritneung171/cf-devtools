export class LogAnalyticsService {

  constructor(private logs: any[]) {}

  parseLog(log: any) {

    if (!log?.Event?.Request?.URL) return null;

    let parsed: URL;
    try {
      parsed = new URL(log.Event.Request.URL);
    } catch {
      return null;
    }

    return {
      ip:        "unknown",
      method:    log?.Event?.Request?.Method  || "GET",
      path:      parsed.pathname,
      status:    log?.Event?.Response?.Status || 200,
      latency:   log?.WallTimeMs              || 0,
      timestamp: log?.EventTimestampMs        || 0,
      rayId:     log?.Event?.RayID            || "",
    };

  }

  getDashboard() {

    let total  = 0;
    let errors = 0;

    const api:     Record<string, number> = {};
    const ips:     Set<string>            = new Set();
    const latencies: number[]             = [];

    for (const raw of this.logs) {

      const log = this.parseLog(raw);
      if (!log) continue;

      total++;
      ips.add(log.ip);
      latencies.push(log.latency);

      const key = `${log.method} ${log.path}`;
      api[key] = (api[key] || 0) + 1;

      if (log.status >= 400) errors++;

    }

    // Response time stats
    latencies.sort((a, b) => a - b);

    const avg_response_ms = latencies.length
      ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length)
      : 0;

    const p95_response_ms = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
    const p99_response_ms = latencies[Math.floor(latencies.length * 0.99)] ?? 0;

    const topApi = Object.entries(api)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    return {
      total_requests:   total,
      errors,
      unique_ips:       ips.size,
      avg_response_ms,
      p95_response_ms,
      p99_response_ms,
      top_api:          topApi,
    };

  }

  getTopIPs() {

    const ips: Record<string, number> = {};

    for (const raw of this.logs) {
      const log = this.parseLog(raw);
      if (!log) continue;
      ips[log.ip] = (ips[log.ip] || 0) + 1;
    }

    return Object.entries(ips)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

  }

  getRecentErrors() {

    const errors: any[] = [];

    for (const raw of this.logs) {
      const log = this.parseLog(raw);
      if (!log) continue;

      if (log.status >= 400) {
        errors.push({
          ip:     log.ip,
          url:    log.path,
          status: log.status,
          time:   log.timestamp,
          rayId:  log.rayId,
          method: log.method,
        });
      }
    }

    return errors.slice(-20).reverse();

  }

}