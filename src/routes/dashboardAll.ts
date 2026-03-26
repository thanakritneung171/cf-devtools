import { R2LogService } from "../services/R2LogService";
import { analyzeLogs } from "../services/DashboardAnalytics";

// ==========================================================
// Cache key: ปัดเป็นทุก 10 นาที + รวม from/to ถ้ามี
// ==========================================================

function buildCacheKey(from?: string, to?: string): string {
  const now = Date.now();
  const d   = new Date(now);
  const hh  = String(d.getUTCHours()).padStart(2, "0");
  const min = String(Math.floor(d.getUTCMinutes() / 10) * 10).padStart(2, "0");

  if (from || to) return `dashboard:${from || "x"}-${to || "x"}:${hh}${min}`;

  const yyyy = d.getUTCFullYear();
  const mm   = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd   = String(d.getUTCDate()).padStart(2, "0");
  return `dashboard:${yyyy}${mm}${dd}:${hh}${min}`;
}

// ==========================================================
// Shared: อ่าน R2 + analyze → JSON string
// ==========================================================

async function fetchAndAnalyze(env: Env, from?: string, to?: string): Promise<string> {
  const r2   = new R2LogService(env.MY_BUCKET);
  const logs = await r2.readLogs({ from, to });
  return JSON.stringify(analyzeLogs(logs));
}

// ==========================================================
// /api/dashboard/all — Stale-While-Revalidate KV cache
//
// 1. ถ้า cache HIT → return ทันที (เก็บเป็น string ไม่ต้อง parse)
//    แล้ว revalidate ใน background ถ้า cache ใกล้หมดอายุ
// 2. ถ้า cache MISS → อ่าน R2 แล้ว cache ผลลัพธ์
// ==========================================================

const CACHE_TTL    = 600;  // 10 นาที
const STALE_AFTER  = 300;  // revalidate หลัง 5 นาที

export async function dashboardAllCached(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) {
  const url  = new URL(request.url);
  const from = url.searchParams.get("from") || undefined;
  const to   = url.searchParams.get("to")   || undefined;

  const cacheKey    = buildCacheKey(from, to);
  const metaKey     = cacheKey + ":ts";

  // อ่าน cache + metadata พร้อมกัน
  const [cached, cachedTs] = await Promise.all([
    env.USERS_CACHE.get(cacheKey),
    env.USERS_CACHE.get(metaKey),
  ]);

  if (cached) {
    // Stale-while-revalidate: ถ้า cache เก่ากว่า STALE_AFTER → refresh background
    const age = cachedTs ? Date.now() - Number(cachedTs) : Infinity;
    if (age > STALE_AFTER * 1000) {
      ctx.waitUntil(
        fetchAndAnalyze(env, from, to).then(json =>
          Promise.all([
            env.USERS_CACHE.put(cacheKey, json, { expirationTtl: CACHE_TTL }),
            env.USERS_CACHE.put(metaKey, String(Date.now()), { expirationTtl: CACHE_TTL }),
          ])
        )
      );
    }

    // Return cached string ตรงๆ — ไม่ต้อง JSON.parse แล้ว JSON.stringify กลับ
    return new Response(cached, {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Cache MISS → fetch + cache
  const json = await fetchAndAnalyze(env, from, to);

  ctx.waitUntil(
    Promise.all([
      env.USERS_CACHE.put(cacheKey, json, { expirationTtl: CACHE_TTL }),
      env.USERS_CACHE.put(metaKey, String(Date.now()), { expirationTtl: CACHE_TTL }),
    ])
  );

  return new Response(json, {
    headers: { "Content-Type": "application/json" },
  });
}

// ==========================================================
// /api/dashboard/all/realtime — ไม่มี cache อ่าน R2 ตรงๆ
// ==========================================================

export async function dashboardAllRealtime(request: Request, env: Env) {
  const url  = new URL(request.url);
  const from = url.searchParams.get("from") || undefined;
  const to   = url.searchParams.get("to")   || undefined;

  const json = await fetchAndAnalyze(env, from, to);

  return new Response(json, {
    headers: { "Content-Type": "application/json" },
  });
}
