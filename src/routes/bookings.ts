import { BookingService } from '../services/BookingService';
import { ProductQueueService } from '../services/ProductQueueService';
import { verifyRequestAuth } from '../utils/auth';
import { CreateBookingInput } from '../types/productPOC';

interface Env {
  DB: D1Database;
  USERS_CACHE: KVNamespace;
  JWT_SECRET?: string;
  BOOKINGS_INDEX: VectorizeIndex;
  AI: Ai;
}

function buildBookingEmbedText(b: { user_id: number; product_id: number; quantity: number; product_name?: string }): string {
  return `booking user:${b.user_id} product:${b.product_id} ${b.product_name || ''} quantity:${b.quantity}`;
}

async function generateEmbedding(ai: Ai, text: string): Promise<number[]> {
  const result = await ai.run('@cf/baai/bge-base-en-v1.5', { text: [text] }) as { data: number[][] };
  return result.data[0];
}

export async function handleBookingRoutes(request: Request, env: Env, url: URL, method: string): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/bookings')) return null;

  const bookingService = new BookingService(env);
  const productQueueService = new ProductQueueService(env);

  // Auth required for all routes
  const authCheck = await verifyRequestAuth(request, env);
  if (authCheck instanceof Response) return authCheck;

  // POST /api/bookings - จองสินค้า (สร้าง booking + product_queue)
  if (url.pathname === '/api/bookings' && method === 'POST') {
    try {
      const body = await request.json<CreateBookingInput>();
      if (!body.user_id || !body.product_id || !body.quantity) {
        return Response.json({ error: 'กรุณากรอก user_id, product_id, quantity' }, { status: 400 });
      }
      const result = await bookingService.createBooking(body);

      // สร้าง Vectorize embedding ถ้าสถานะเป็น booked (ACTIVE)
      if (result.booking.status === 'booked') {
        const product = await env.DB.prepare('SELECT product_name FROM productsPOC WHERE id = ?')
          .bind(body.product_id).first<{ product_name: string }>();
        const embedText = buildBookingEmbedText({
          ...body,
          product_name: product?.product_name,
        });
        const embedding = await generateEmbedding(env.AI, embedText);
        await env.BOOKINGS_INDEX.insert([
          {
            id: String(result.booking.id),
            values: embedding,
            metadata: {
              user_id: String(body.user_id),
              product_id: String(body.product_id),
              quantity: String(body.quantity),
              product_name: product?.product_name || '',
              status: 'booked',
            },
          },
        ]);
      }

      return Response.json(result, { status: 201 });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // GET /api/bookings/search/fast?q=... — semantic search (metadata only)
  if (url.pathname === '/api/bookings/search/fast' && method === 'GET') {
    try {
      const q = url.searchParams.get('q');
      if (!q) return Response.json({ error: 'กรุณาระบุ query parameter q' }, { status: 400 });

      const topK = parseInt(url.searchParams.get('topK') || '5');
      const embedding = await generateEmbedding(env.AI, q);
      const matches = await env.BOOKINGS_INDEX.query(embedding, {
        topK,
        returnMetadata: 'all',
        returnValues: true,
      });

      return Response.json({ matches });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ค้นหาไม่สำเร็จ' }, { status: 500 });
    }
  }

  // GET /api/bookings/search?q=... — semantic search + D1 data
  if (url.pathname === '/api/bookings/search' && method === 'GET') {
    try {
      const q = url.searchParams.get('q');
      if (!q) return Response.json({ error: 'กรุณาระบุ query parameter q' }, { status: 400 });

      const topK = parseInt(url.searchParams.get('topK') || '5');
      const embedding = await generateEmbedding(env.AI, q);
      const matches = await env.BOOKINGS_INDEX.query(embedding, {
        topK,
        returnMetadata: 'all',
      });

      if (!matches.matches || matches.matches.length === 0) {
        return Response.json({ results: [] });
      }

      const ids = matches.matches.map((m) => m.id);
      const placeholders = ids.map(() => '?').join(',');
      const bookings = await env.DB.prepare(
        `SELECT * FROM bookings WHERE id IN (${placeholders})`
      )
        .bind(...ids.map(Number))
        .all();

      const scoreMap = new Map(matches.matches.map((m) => [m.id, m.score]));
      const results = (bookings.results ?? [])
        .map((b: any) => ({ ...b, score: scoreMap.get(String(b.id)) ?? 0 }))
        .sort((a: any, b: any) => b.score - a.score);

      return Response.json({ results });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ค้นหาไม่สำเร็จ' }, { status: 500 });
    }
  }

  // POST /api/bookings/filter — filter ตรงจาก D1
  // Body: { status?, user_id?, product_id?, page?, limit? }
  if (url.pathname === '/api/bookings/filter' && method === 'POST') {
    try {
      const body = await request.json<{ status?: string; user_id?: number; product_id?: number; page?: number; limit?: number }>();
      const status = body.status || undefined;
      const userId = body.user_id || undefined;
      const productId = body.product_id || undefined;
      const page = body.page || 1;
      const limit = body.limit || 10;

      let query = `
        SELECT
          b.id, b.user_id, b.product_id, b.quantity, b.status,
          b.booking_date, b.estimated_complete_at, b.countdown_seconds,
          u.first_name, u.last_name, u.email,
          p.product_name, p.description AS product_description,
          p.price, p.total_quantity, p.available_quantity,
          f.file_path AS product_image_path
        FROM bookings b
        LEFT JOIN users u ON b.user_id = u.id
        LEFT JOIN productsPOC p ON b.product_id = p.id
        LEFT JOIN files f ON p.image_id = f.id
        WHERE 1=1`;
      let countQuery = 'SELECT COUNT(*) as count FROM bookings b WHERE 1=1';
      const params: any[] = [];
      const countParams: any[] = [];

      if (status) {
        query += ' AND b.status = ?';
        countQuery += ' AND b.status = ?';
        params.push(status);
        countParams.push(status);
      }
      if (userId) {
        query += ' AND b.user_id = ?';
        countQuery += ' AND b.user_id = ?';
        params.push(userId);
        countParams.push(userId);
      }
      if (productId) {
        query += ' AND b.product_id = ?';
        countQuery += ' AND b.product_id = ?';
        params.push(productId);
        countParams.push(productId);
      }

      const countResult = await env.DB.prepare(countQuery).bind(...countParams).first<{ count: number }>();
      const total = countResult?.count || 0;

      const offset = (page - 1) * limit;
      query += ' ORDER BY b.booking_date DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const results = await env.DB.prepare(query).bind(...params).all<any>();
      const r2Domain = (env as any).R2_DOMAIN || 'https://pub-5996ee0506414893a70d525a21960eba.r2.dev';

      const data = (results.results || []).map((row: any) => {
        const { product_image_path, ...rest } = row;
        return {
          ...rest,
          product_image_url: product_image_path ? `${r2Domain}/${product_image_path}` : null,
        };
      });

      return Response.json({
        data,
        pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
      });
    } catch (error: any) {
      return Response.json({ error: error.message || 'กรองข้อมูลไม่สำเร็จ' }, { status: 500 });
    }
  }

  // GET /api/bookings - ดูการจองทั้งหมด
  if (url.pathname === '/api/bookings' && method === 'GET') {
    try {
      const page = parseInt(url.searchParams.get('page') || '1');
      const limit = parseInt(url.searchParams.get('limit') || '10');
      const result = await bookingService.getAllBookings(page, limit);
      return Response.json({
        data: result.data,
        pagination: { page, limit, total: result.total, total_pages: Math.ceil(result.total / limit) },
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // GET /api/bookings/user/:userId
  const userMatch = url.pathname.match(/^\/api\/bookings\/user\/(\d+)$/);
  if (userMatch && method === 'GET') {
    try {
      const bookings = await bookingService.getBookingsByUser(parseInt(userMatch[1]));
      return Response.json({ data: bookings });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // GET /api/bookings/product/:productId
  const productMatch = url.pathname.match(/^\/api\/bookings\/product\/(\d+)$/);
  if (productMatch && method === 'GET') {
    try {
      const bookings = await bookingService.getBookingsByProduct(parseInt(productMatch[1]));
      return Response.json({ data: bookings });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // GET /api/bookings/:id - ดูการจองตาม ID
  const singleMatch = url.pathname.match(/^\/api\/bookings\/(\d+)$/);
  if (singleMatch && method === 'GET') {
    try {
      const booking = await bookingService.getBookingById(parseInt(singleMatch[1]));
      if (!booking) return Response.json({ error: 'ไม่พบการจอง' }, { status: 404 });

      // ดึง product_queue ที่เชื่อมกับ booking นี้ด้วย
      const queueEntry = await productQueueService.getByBookingId(booking.id);
      return Response.json({ data: booking, product_queue: queueEntry });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // PUT /api/bookings/:id/complete — เสร็จสิ้น (ใช้ /leave logic, ไม่คืน stock)
  const completeMatch = url.pathname.match(/^\/api\/bookings\/(\d+)\/complete$/);
  if (completeMatch && method === 'PUT') {
    try {
      const bookingId = parseInt(completeMatch[1]);
      const booking = await bookingService.completeBooking(bookingId);
      if (!booking) return Response.json({ error: 'ไม่พบการจองหรือไม่สามารถ complete ได้' }, { status: 404 });

      // ลบ vector จาก Vectorize
      await env.BOOKINGS_INDEX.deleteByIds([String(bookingId)]);

      return Response.json({
        booking,
        message: 'เสร็จสิ้นการจอง product_queue เปลี่ยนเป็น completed คิว WAITING ถัดไปได้ promote เป็น ACTIVE',
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // PUT /api/bookings/:id/cancel — ยกเลิก (ใช้ /leave logic, คืน stock + ลบ product_queue)
  const cancelMatch = url.pathname.match(/^\/api\/bookings\/(\d+)\/cancel$/);
  if (cancelMatch && method === 'PUT') {
    try {
      const bookingId = parseInt(cancelMatch[1]);
      const booking = await bookingService.cancelBooking(bookingId);
      if (!booking) return Response.json({ error: 'ไม่พบการจองหรือถูกยกเลิกแล้ว' }, { status: 404 });

      // ลบ vector จาก Vectorize
      await env.BOOKINGS_INDEX.deleteByIds([String(bookingId)]);

      return Response.json({
        booking,
        message: 'ยกเลิกการจองสำเร็จ คืน stock แล้ว ลบ product_queue แล้ว คิว WAITING ถัดไปได้ promote เป็น ACTIVE',
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  return null;
}
