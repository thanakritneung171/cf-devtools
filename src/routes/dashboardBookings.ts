import { verifyRequestAuth } from '../utils/auth';

interface Env {
  DB: D1Database;
  USERS_CACHE: KVNamespace;
  JWT_SECRET?: string;
}

/**
 * POST /api/dashboard/bookings
 *
 * Body (JSON):
 *   start_date  — ISO date string เช่น "2025-01-01" (default: 30 วันที่แล้ว)
 *   end_date    — ISO date string เช่น "2025-12-31" (default: วันนี้)
 *   status      — "booked" | "WAITING" | "cancelled" | "completed" (optional)
 *   product_id  — number, filter เฉพาะ product (optional)
 *   group_by    — "day" | "week" | "month" (default: "day")
 */
export async function handleDashboardBookingsRoutes(
  request: Request,
  env: Env,
  url: URL,
  method: string
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/dashboard/bookings')) return null;

  const authCheck = await verifyRequestAuth(request, env);
  if (authCheck instanceof Response) return authCheck;

  if (url.pathname === '/api/dashboard/bookings' && method === 'POST') {
    try {
      // ---- Parse body ----
      const now = new Date();
      const defaultStart = new Date(now);
      defaultStart.setDate(defaultStart.getDate() - 30);

      const body = await request.json<{
        start_date?: string;
        end_date?: string;
        status?: string;
        product_id?: number;
        group_by?: string;
      }>();

      const startDate = body.start_date || defaultStart.toISOString().slice(0, 10);
      const endDate = body.end_date || now.toISOString().slice(0, 10);
      const status = body.status || undefined;
      const productId = body.product_id || undefined;
      const groupBy = body.group_by || 'day';

      // ---- Build WHERE clause ----
      const conditions: string[] = [
        `b.booking_date >= ?`,
        `b.booking_date < date(?, '+1 day')`,
      ];
      const baseParams: any[] = [startDate, endDate];

      if (status) {
        conditions.push('b.status = ?');
        baseParams.push(status);
      }
      if (productId) {
        conditions.push('b.product_id = ?');
        baseParams.push(productId);
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      // ---- Summary: total bookings + revenue ----
      const summaryResult = await env.DB.prepare(
        `SELECT
           COUNT(*) as total_bookings,
           COALESCE(SUM(b.quantity * p.price), 0) as total_revenue
         FROM bookings b
         LEFT JOIN productsPOC p ON b.product_id = p.id
         ${whereClause}`
      )
        .bind(...baseParams)
        .first<{ total_bookings: number; total_revenue: number }>();

      // ---- Summary by status ----
      const byStatusResult = await env.DB.prepare(
        `SELECT b.status, COUNT(*) as count, COALESCE(SUM(b.quantity * p.price), 0) as revenue
         FROM bookings b
         LEFT JOIN productsPOC p ON b.product_id = p.id
         ${whereClause}
         GROUP BY b.status`
      )
        .bind(...baseParams)
        .all<{ status: string; count: number; revenue: number }>();

      // ---- Chart: grouped by day/week/month ----
      let dateTrunc: string;
      if (groupBy === 'month') {
        dateTrunc = `strftime('%Y-%m', b.booking_date)`;
      } else if (groupBy === 'week') {
        dateTrunc = `strftime('%Y-W%W', b.booking_date)`;
      } else {
        dateTrunc = `strftime('%Y-%m-%d', b.booking_date)`;
      }

      const chartResult = await env.DB.prepare(
        `SELECT
           ${dateTrunc} as period,
           COUNT(*) as bookings,
           COALESCE(SUM(b.quantity * p.price), 0) as revenue
         FROM bookings b
         LEFT JOIN productsPOC p ON b.product_id = p.id
         ${whereClause}
         GROUP BY period
         ORDER BY period ASC`
      )
        .bind(...baseParams)
        .all<{ period: string; bookings: number; revenue: number }>();

      // ---- Top products ----
      const topProductsResult = await env.DB.prepare(
        `SELECT
           p.id as product_id,
           p.product_name,
           COUNT(*) as booking_count,
           COALESCE(SUM(b.quantity), 0) as total_quantity,
           COALESCE(SUM(b.quantity * p.price), 0) as revenue
         FROM bookings b
         LEFT JOIN productsPOC p ON b.product_id = p.id
         ${whereClause}
         GROUP BY b.product_id
         ORDER BY booking_count DESC
         LIMIT 10`
      )
        .bind(...baseParams)
        .all<{ product_id: number; product_name: string; booking_count: number; total_quantity: number; revenue: number }>();

      return Response.json({
        filter: { start_date: startDate, end_date: endDate, status, product_id: productId, group_by: groupBy },
        summary: {
          total_bookings: summaryResult?.total_bookings || 0,
          total_revenue: summaryResult?.total_revenue || 0,
          by_status: byStatusResult.results || [],
        },
        chart: chartResult.results || [],
        top_products: topProductsResult.results || [],
      });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ดึงข้อมูล dashboard ไม่สำเร็จ' }, { status: 500 });
    }
  }

  return null;
}
