import { R2LogService } from "../services/R2LogService";
import { analyzeLogs } from "../services/DashboardAnalytics";

// ==========================================================
// Cache key: ปัดเป็นทุก 10 นาที + รวม from/to ถ้ามี
// เช่น dashboard:20260326:1430 หรือ dashboard:20260320-20260326:1430
// ==========================================================

function buildCacheKey(from?: string, to?: string): string {
  const now  = new Date();
  const yyyy = now.getUTCFullYear();
  const mm   = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd   = String(now.getUTCDate()).padStart(2, "0");
  const hh   = String(now.getUTCHours()).padStart(2, "0");
  const min  = String(Math.floor(now.getUTCMinutes() / 10) * 10).padStart(2, "0");

  const dateRange = from || to ? `${from || "x"}-${to || "x"}` : `${yyyy}${mm}${dd}`;
  return `dashboard:${dateRange}:${hh}${min}`;
}

// ==========================================================
// /api/dashboard/all — มี KV cache (TTL 10 นาที)
// ==========================================================

export async function dashboardAllCached(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) {
  const url  = new URL(request.url);
  const from = url.searchParams.get("from") || undefined;
  const to   = url.searchParams.get("to")   || undefined;

  const cacheKey = buildCacheKey(from, to);

  // ลองอ่านจาก cache ก่อน
  const cached = await env.USERS_CACHE.get(cacheKey, "json");
  if (cached) {
    console.log("[DashboardAll] cache HIT:", cacheKey);
    return Response.json(cached);
  }

  console.log("[DashboardAll] cache MISS:", cacheKey);

  // อ่าน R2 + analyze
  const r2     = new R2LogService(env.MY_BUCKET);
  const logs   = await r2.readLogs({ from, to });
  const result = analyzeLogs(logs);

  // เขียน cache แบบ non-blocking
  ctx.waitUntil(
    env.USERS_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 600 })
  );

  return Response.json(result);
}

// ==========================================================
// /api/dashboard/all/realtime — ไม่มี cache อ่าน R2 ตรงๆ
// ==========================================================

export async function dashboardAllRealtime(request: Request, env: Env) {
  const url  = new URL(request.url);
  const from = url.searchParams.get("from") || undefined;
  const to   = url.searchParams.get("to")   || undefined;

  const r2     = new R2LogService(env.MY_BUCKET);
  const logs   = await r2.readLogs({ from, to });
  const result = analyzeLogs(logs);

  return Response.json(result);
}
