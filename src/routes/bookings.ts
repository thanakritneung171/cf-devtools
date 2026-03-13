import { BookingService } from '../services/BookingService';
import { QueueService } from '../services/QueueService';
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
  const queueService = new QueueService(env);

  // Auth required for all routes
  const authCheck = await verifyRequestAuth(request, env);
  if (authCheck instanceof Response) return authCheck;

  // POST /api/bookings - จองสินค้า
  if (url.pathname === '/api/bookings' && method === 'POST') {
    try {
      const body = await request.json<CreateBookingInput>();
      if (!body.user_id || !body.product_id || !body.quantity) {
        return Response.json({ error: 'กรุณากรอก user_id, product_id, quantity' }, { status: 400 });
      }
      const result = await bookingService.createBooking(body);

      // สร้าง Vectorize embedding ถ้าจองสำเร็จ
      if (result.booking) {
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

  // PUT /api/bookings/:id/cancel - ยกเลิกการจอง
  const cancelMatch = url.pathname.match(/^\/api\/bookings\/(\d+)\/cancel$/);
  if (cancelMatch && method === 'PUT') {
    try {
      const bookingId = parseInt(cancelMatch[1]);
      const booking = await bookingService.cancelBooking(bookingId);
      if (!booking) return Response.json({ error: 'ไม่พบการจองหรือถูกยกเลิกแล้ว' }, { status: 404 });

      // ลบ vector จาก Vectorize
      await env.BOOKINGS_INDEX.deleteByIds([String(bookingId)]);

      return Response.json({ booking, message: 'ยกเลิกการจองสำเร็จ' });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // GET /api/bookings/queue/:productId - ดูคิวของสินค้า
  const queueMatch = url.pathname.match(/^\/api\/bookings\/queue\/(\d+)$/);
  if (queueMatch && method === 'GET') {
    try {
      const queue = await queueService.getQueueByProduct(parseInt(queueMatch[1]));
      return Response.json({ data: queue });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // PUT /api/bookings/queue/:id/cancel - ยกเลิกคิว
  const queueCancelMatch = url.pathname.match(/^\/api\/bookings\/queue\/(\d+)\/cancel$/);
  if (queueCancelMatch && method === 'PUT') {
    try {
      const item = await queueService.cancelQueue(parseInt(queueCancelMatch[1]));
      if (!item) return Response.json({ error: 'ไม่พบคิวหรือไม่ได้อยู่ในสถานะรอ' }, { status: 404 });
      return Response.json({ queue: item, message: 'ยกเลิกคิวสำเร็จ' });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  return null;
}
