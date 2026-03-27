// ==========================================================
// Shared dashboard analytics — extract + aggregate logs
//
// Optimizations:
//  1. Auto-detect log format จาก entry แรก → fast path ไม่ต้องลอง field ทุกตัว
//  2. Pure string parse pathname แทน new URL() (เร็วกว่า ~10x)
//  3. Pure math หา hour แทน new Date() ทุก entry
//  4. QuickSelect O(N) สำหรับ percentiles แทน full sort O(N log N)
//  5. Circular buffer สำหรับ recent errors แทน shift() O(N)
//  6. Lazy error message extraction เฉพาะ status >= 400
//  7. Map + inline LatencyStats ไม่สร้าง array แล้ว reduce
//  8. Partial sort O(N*K) สำหรับ top-N
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
// Log format detection — ตรวจจาก entry แรกแล้วใช้ fast accessor
// ==========================================================

const enum LogFormat {
  WORKERS_TRACE = 0,   // Event.Request.URL
  HTTP_LOG      = 1,   // ClientRequestURI
  GENERIC       = 2,   // request.url
  FLAT          = 3,   // URL (top-level)
  UNKNOWN       = 4,
}

function detectFormat(sample: any): LogFormat {
  if (sample?.Event?.Request?.URL) return LogFormat.WORKERS_TRACE;
  if (sample?.ClientRequestURI)    return LogFormat.HTTP_LOG;
  if (sample?.request?.url)        return LogFormat.GENERIC;
  if (sample?.URL)                 return LogFormat.FLAT;
  return LogFormat.UNKNOWN;
}

// Fast field accessors per format — ลด optional chaining จาก 4 เหลือ 1
function getUrl(raw: any, fmt: LogFormat): string {
  switch (fmt) {
    case LogFormat.WORKERS_TRACE: return raw.Event.Request.URL   || "";
    case LogFormat.HTTP_LOG:      return raw.ClientRequestURI    || "";
    case LogFormat.GENERIC:       return raw.request.url         || "";
    case LogFormat.FLAT:          return raw.URL                 || "";
    default:
      return raw?.Event?.Request?.URL || raw?.ClientRequestURI || raw?.request?.url || raw?.URL || "";
  }
}

function getStatus(raw: any, fmt: LogFormat): number {
  switch (fmt) {
    case LogFormat.WORKERS_TRACE: return raw.Event.Response?.Status || 200;
    case LogFormat.HTTP_LOG:      return raw.EdgeResponseStatus     || 200;
    case LogFormat.GENERIC:       return raw.status                 || 200;
    case LogFormat.FLAT:          return raw.Status                 || 200;
    default:
      return raw?.Event?.Response?.Status || raw?.EdgeResponseStatus || raw?.status || raw?.Status || 200;
  }
}

function getMethod(raw: any, fmt: LogFormat): string {
  switch (fmt) {
    case LogFormat.WORKERS_TRACE: return raw.Event.Request.Method || "GET";
    case LogFormat.HTTP_LOG:      return raw.ClientRequestMethod  || "GET";
    case LogFormat.GENERIC:       return raw.request.method       || "GET";
    case LogFormat.FLAT:          return raw.Method               || "GET";
    default:
      return raw?.Event?.Request?.Method || raw?.ClientRequestMethod || raw?.request?.method || raw?.Method || "GET";
  }
}

function getTime(raw: any, fmt: LogFormat): number {
  switch (fmt) {
    case LogFormat.WORKERS_TRACE: return raw.EventTimestampMs   || 0;
    case LogFormat.HTTP_LOG:      return raw.EdgeStartTimestamp  || 0;
    case LogFormat.GENERIC:       return raw.timestamp           || 0;
    case LogFormat.FLAT:          return raw.Timestamp           || 0;
    default:
      return raw?.EventTimestampMs || raw?.EdgeStartTimestamp || raw?.Timestamp || raw?.timestamp || 0;
  }
}

function getRayId(raw: any, fmt: LogFormat): string {
  switch (fmt) {
    case LogFormat.WORKERS_TRACE: return raw.Event.RayID || "";
    case LogFormat.HTTP_LOG:      return raw.RayID       || "";
    case LogFormat.GENERIC:       return raw.rayId       || "";
    case LogFormat.FLAT:          return raw.RayID       || "";
    default:
      return raw?.Event?.RayID || raw?.RayID || raw?.rayId || "";
  }
}

function getLatency(raw: any): number {
  return raw?.WallTimeMs || raw?.OriginResponseTime || raw?.EdgeTimeToFirstByteMs || 0;
}

function getIp(raw: any, fmt: LogFormat): string {
  switch (fmt) {
    case LogFormat.HTTP_LOG:  return raw.ClientIP                    || "unknown";
    case LogFormat.GENERIC:   return raw.ip || raw.request?.cf?.connecting_ip || "unknown";
    default:
      return raw?.ClientIP || raw?.ip || raw?.request?.cf?.connecting_ip || "unknown";
  }
}

// ==========================================================
// Parse pathname จาก URL string — ไม่ใช้ new URL()
// "https://example.com/api/foo?bar=1" → "/api/foo"
// ==========================================================

function fastPathname(rawUrl: string): string {
  const c0 = rawUrl.charCodeAt(0);

  // path-only เช่น "/api/users?page=1"
  if (c0 === 47) { // '/'
    const q = rawUrl.indexOf("?");
    return q === -1 ? rawUrl : rawUrl.substring(0, q);
  }

  // full URL — หา path หลัง "://" + host
  if (c0 === 104) { // 'h' → http(s)://
    const protoEnd = rawUrl.indexOf("://");
    if (protoEnd !== -1) {
      const pathStart = rawUrl.indexOf("/", protoEnd + 3);
      if (pathStart === -1) return "/";
      const q = rawUrl.indexOf("?", pathStart);
      return q === -1 ? rawUrl.substring(pathStart) : rawUrl.substring(pathStart, q);
    }
  }

  // fallback
  const q = rawUrl.indexOf("?");
  return q === -1 ? rawUrl : rawUrl.substring(0, q);
}

// ==========================================================
// Extract error message — เรียกเฉพาะ status >= 400
// ==========================================================

function extractErrorMessage(raw: any): string {
  const exceptions = raw?.Exceptions;
  if (exceptions && exceptions.length > 0) {
    let msg = "";
    for (let i = 0; i < exceptions.length; i++) {
      const e = exceptions[i];
      if (i > 0) msg += ", ";
      msg += e?.Message || e?.name || JSON.stringify(e);
    }
    return msg;
  }

  const logs = raw?.Logs;
  if (logs && logs.length > 0) {
    let msg = "";
    for (let i = 0; i < logs.length; i++) {
      const l = logs[i];
      if (l?.Level !== "error" && l?.Level !== "warn") continue;
      if (msg) msg += ", ";
      msg += Array.isArray(l?.Message) ? l.Message.join(" ") : (l?.Message || "");
    }
    return msg;
  }

  return "";
}

// ==========================================================
// extractFields — public API สำหรับ external use
// ==========================================================

export function extractFields(log: any): ExtractedLog {
  const fmt    = detectFormat(log);
  const rawUrl = getUrl(log, fmt);
  return {
    rawUrl,
    path:         rawUrl ? fastPathname(rawUrl) : "unknown",
    status:       getStatus(log, fmt),
    time:         getTime(log, fmt),
    rayId:        getRayId(log, fmt),
    method:       getMethod(log, fmt),
    latency:      getLatency(log),
    ip:           getIp(log, fmt),
    errorMessage: extractErrorMessage(log),
  };
}

// ==========================================================
// analyzeLogs — single-pass aggregation, maximum throughput
// ==========================================================

const TZ_OFFSET_MS = 7 * 60 * 60 * 1000;
const MS_PER_HOUR  = 3_600_000;
const MS_PER_DAY   = 86_400_000;

interface LatencyStats { sum: number; count: number; max: number; }

export function analyzeLogs(logs: any[]): DashboardResult {

  const len = logs.length;
  if (len === 0) return emptyResult();

  // Detect format จาก entry แรก → ใช้ fast accessor ตลอด
  const fmt = detectFormat(logs[0]);

  // Precompute "today" boundaries (เวลาไทย UTC+7) ด้วย pure math
  const nowMs        = Date.now();
  const nowLocal     = nowMs + TZ_OFFSET_MS;
  const todayStartMs = nowLocal - (nowLocal % MS_PER_DAY) - TZ_OFFSET_MS;
  const todayEndMs   = todayStartMs + MS_PER_DAY;

  const endpointCount   = new Map<string, number>();
  const endpointLatency = new Map<string, LatencyStats>();
  const ipCount         = new Map<string, number>();
  const hourlyCount     = new Int32Array(24);

  // Circular buffer สำหรับ recent errors (ไม่ต้อง shift)
  const MAX_ERRORS    = 20;
  const errorBuf: any[] = new Array(MAX_ERRORS);
  let errorBufIdx     = 0;
  let errorBufFull    = false;

  const latencies: number[] = [];

  let total_requests = 0;
  let errorCount     = 0;
  let latencySum     = 0;

  for (let i = 0; i < len; i++) {
    const raw = logs[i];

    // ---- Fast field extraction ----
    const rawUrl = getUrl(raw, fmt);
    const rayId  = getRayId(raw, fmt);

    if (!rawUrl && !rayId) continue;

    // Parse path — pure string, ไม่ใช้ new URL()
    const path = rawUrl ? fastPathname(rawUrl) : "unknown";

    // Ignore dashboard routes (check prefix ด้วย charCode ก่อนเพื่อ early exit)
    const pc = path.charCodeAt(1); // ตัวหลัง '/'
    if (pc === 100 || pc === 97) { // 'd'ashboard or 'a'pi
      if (path.startsWith("/dashboard") || path.startsWith("/api/dashboard")) continue;
    }

    const status  = getStatus(raw, fmt);
    const method  = getMethod(raw, fmt).toUpperCase();
    const latency = getLatency(raw);
    const ip      = getIp(raw, fmt);

    total_requests++;
    latencies.push(latency);
    latencySum += latency;

    // Count IP
    ipCount.set(ip, (ipCount.get(ip) || 0) + 1);

    // Count endpoint + inline latency stats
    const methodPath = method + " " + path;
    endpointCount.set(methodPath, (endpointCount.get(methodPath) || 0) + 1);

    let stats = endpointLatency.get(methodPath);
    if (stats) {
      stats.sum += latency;
      stats.count++;
      if (latency > stats.max) stats.max = latency;
    } else {
      endpointLatency.set(methodPath, { sum: latency, count: 1, max: latency });
    }

    // แปลง timestamp ให้เป็น number + fallback Date.now() เหมือน dashboard.ts
    const rawTs = getTime(raw, fmt);
    const ts = typeof rawTs === "number" && rawTs > 0 ? rawTs
             : typeof rawTs === "string" ? parseInt(rawTs as any) || nowMs
             : nowMs;

    // Errors — lazy error message
    if (status >= 400) {
      errorCount++;
      const message = extractErrorMessage(raw);

      errorBuf[errorBufIdx] = { time: ts, ip, url: path, status, rayId, method, message: message || "" };
      errorBufIdx++;
      if (errorBufIdx >= MAX_ERRORS) {
        errorBufIdx = 0;
        errorBufFull = true;
      }
    }

    // Traffic hourly — นับเฉพาะวันนี้ เวลาไทย UTC+7
    if (ts >= todayStartMs && ts < todayEndMs) {
      const hour = Math.floor(((ts + TZ_OFFSET_MS) % MS_PER_DAY) / MS_PER_HOUR);
      hourlyCount[hour]++;
    }
  }

  // ==========================================================
  // Aggregate
  // ==========================================================

  // Top 30 API
  const top_api = topN([...endpointCount.entries()], 30, (a, b) => b[1] - a[1]);

  // Slowest 5 API
  const slowCandidates: { endpoint: string; avg_ms: number; max_ms: number; count: number }[] = [];
  for (const [endpoint, s] of endpointLatency) {
    if (s.count >= 2) {
      slowCandidates.push({ endpoint, avg_ms: Math.round(s.sum / s.count), max_ms: s.max, count: s.count });
    }
  }
  const slowest_api = topN(slowCandidates, 5, (a, b) => b.avg_ms - a.avg_ms);

  // Percentiles — QuickSelect O(N) แทน full sort O(N log N)
  const n = latencies.length;
  const avg_response_ms = n ? Math.round(latencySum / n) : 0;
  const p95_response_ms = n ? quickSelect(latencies, Math.floor(n * 0.95)) : 0;
  const p99_response_ms = n ? quickSelect(latencies, Math.floor(n * 0.99)) : 0;

  // Traffic array จาก Int32Array
  const traffic: number[] = new Array(24);
  for (let h = 0; h < 24; h++) traffic[h] = hourlyCount[h];

  // Top 10 IPs
  const topIPs = topN([...ipCount.entries()], 10, (a, b) => b[1] - a[1]) as [string, number][];

  // Unwind circular buffer → recent errors (ใหม่สุดก่อน)
  let recent_errors: any[];
  if (!errorBufFull) {
    recent_errors = errorBuf.slice(0, errorBufIdx).reverse();
  } else {
    // อ่านจาก circular buffer ตามลำดับเก่า→ใหม่ แล้ว reverse
    recent_errors = new Array(MAX_ERRORS);
    for (let j = 0; j < MAX_ERRORS; j++) {
      recent_errors[j] = errorBuf[(errorBufIdx + j) % MAX_ERRORS];
    }
    recent_errors.reverse();
  }

  console.log("[DashboardAnalytics] logs:", len, "| counted:", total_requests, "| errors:", errorCount);

  return {
    summary: {
      total_requests,
      errors: errorCount,
      avg_response_ms,
      p95_response_ms,
      p99_response_ms,
      top_api,
      slowest_api,
      traffic,
    },
    errors: recent_errors,
    topIPs,
  };
}

function emptyResult(): DashboardResult {
  return {
    summary: {
      total_requests: 0, errors: 0,
      avg_response_ms: 0, p95_response_ms: 0, p99_response_ms: 0,
      top_api: [], slowest_api: [], traffic: new Array(24).fill(0),
    },
    errors: [],
    topIPs: [],
  };
}

// ==========================================================
// QuickSelect — O(N) average สำหรับหา k-th smallest
// ==========================================================

function quickSelect(arr: number[], k: number): number {
  if (k < 0 || k >= arr.length) return 0;

  // ทำงานบน copy เพื่อไม่แก้ original
  const a = arr.slice();
  let lo = 0, hi = a.length - 1;

  while (lo < hi) {
    const pivot = a[lo + ((hi - lo) >> 1)];
    let i = lo, j = hi;

    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
        i++; j--;
      }
    }

    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }

  return a[k];
}

// ==========================================================
// Partial sort — O(N*K) สำหรับ top-N เมื่อ K << N
// ==========================================================

function topN<T>(arr: T[], k: number, cmp: (a: T, b: T) => number): T[] {
  if (arr.length <= k) {
    arr.sort(cmp);
    return arr;
  }

  const result: T[] = arr.slice(0, k);
  result.sort(cmp);

  for (let i = k; i < arr.length; i++) {
    if (cmp(arr[i], result[k - 1]) < 0) {
      result[k - 1] = arr[i];
      let j = k - 1;
      while (j > 0 && cmp(result[j], result[j - 1]) < 0) {
        const tmp = result[j];
        result[j] = result[j - 1];
        result[j - 1] = tmp;
        j--;
      }
    }
  }

  return result;
}
