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

  // GET /api/bookings/:id - ดูการจองตาม ID
  const singleMatch = url.pathname.match(/^\/api\/bookings\/(\d+)$/);
  if (singleMatch && method === 'GET') {
    try {
      const booking = await bookingService.getBookingById(parseInt(singleMatch[1]));
      if (!booking) return Response.json({ error: 'ไม่พบการจอง' }, { status: 404 });
      return Response.json({ data: booking });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // PUT /api/bookings/:id/complete - อัปเดตสถานะเป็นเสร็จสิ้น (คืน stock + process queue)
  const completeMatch = url.pathname.match(/^\/api\/bookings\/(\d+)\/complete$/);
  if (completeMatch && method === 'PUT') {
    try {
      const bookingId = parseInt(completeMatch[1]);
      const booking = await bookingService.completeBooking(bookingId);
      if (!booking) return Response.json({ error: 'ไม่พบการจองหรือไม่ได้อยู่ในสถานะ booked' }, { status: 404 });

      // ลบ vector จาก Vectorize
      await env.BOOKINGS_INDEX.deleteByIds([String(bookingId)]);

      return Response.json({ booking, message: 'เสร็จสิ้นการจองสำเร็จ สินค้าถูกคืน stock และ queue ถัดไปได้รับการประมวลผลแล้ว' });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // POST /api/bookings/:id/start-countdown - เริ่มจำลองนับถอยหลัง (random วินาที)
  const countdownStartMatch = url.pathname.match(/^\/api\/bookings\/(\d+)\/start-countdown$/);
  if (countdownStartMatch && method === 'POST') {
    try {
      const bookingId = parseInt(countdownStartMatch[1]);
      let minSeconds = 10;
      let maxSeconds = 120;

      try {
        const body = await request.json<{ min_seconds?: number; max_seconds?: number }>();
        if (body.min_seconds) minSeconds = body.min_seconds;
        if (body.max_seconds) maxSeconds = body.max_seconds;
      } catch { /* ใช้ค่า default */ }

      const countdown = await bookingService.startCountdown(bookingId, minSeconds, maxSeconds);
      if (!countdown) return Response.json({ error: 'ไม่พบการจองหรือไม่ได้อยู่ในสถานะ booked' }, { status: 404 });

      return Response.json({
        countdown,
        message: `เริ่มนับถอยหลัง ${countdown.countdown_seconds} วินาที เมื่อหมดเวลาจะ complete อัตโนมัติ`,
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // GET /api/bookings/:id/countdown - ดูสถานะ countdown (ถ้าหมดเวลา auto-complete)
  const countdownCheckMatch = url.pathname.match(/^\/api\/bookings\/(\d+)\/countdown$/);
  if (countdownCheckMatch && method === 'GET') {
    try {
      const countdown = await bookingService.checkCountdown(parseInt(countdownCheckMatch[1]));
      if (!countdown) return Response.json({ error: 'ไม่พบการจอง' }, { status: 404 });

      return Response.json({
        countdown,
        message: countdown.is_completed
          ? 'หมดเวลาแล้ว! การจองเสร็จสิ้น คิวถัดไปได้รับการประมวลผลแล้ว'
          : `เหลือเวลาอีก ${countdown.remaining_seconds} วินาที`,
      });
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

  // GET /api/bookings/queue - ดู bookingQueue ทั้งหมด
  if (url.pathname === '/api/bookings/queue' && method === 'GET') {
    try {
      const page = parseInt(url.searchParams.get('page') || '1');
      const limit = parseInt(url.searchParams.get('limit') || '10');
      const status = url.searchParams.get('status') || undefined; // waiting / completed / cancelled
      const result = await queueService.getAllQueues(page, limit, status);
      return Response.json({
        data: result.data,
        pagination: { page, limit, total: result.total, total_pages: Math.ceil(result.total / limit) },
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // POST /api/bookings/from-queue/:queueId - สร้าง booking จาก bookingQueue ID
  const fromQueueMatch = url.pathname.match(/^\/api\/bookings\/from-queue\/(\d+)$/);
  if (fromQueueMatch && method === 'POST') {
    try {
      const queueId = parseInt(fromQueueMatch[1]);
      const result = await bookingService.createBookingFromQueue(queueId);
      if (!result) return Response.json({ error: 'ไม่พบคิวหรือคิวไม่ได้อยู่ในสถานะ waiting' }, { status: 404 });

      // สร้าง Vectorize embedding สำหรับ booking ใหม่
      const product = await env.DB.prepare('SELECT product_name FROM productsPOC WHERE id = ?')
        .bind(result.booking.product_id).first<{ product_name: string }>();
      const embedText = buildBookingEmbedText({
        user_id: result.booking.user_id,
        product_id: result.booking.product_id,
        quantity: result.booking.quantity,
        product_name: product?.product_name,
      });
      const embedding = await generateEmbedding(env.AI, embedText);
      await env.BOOKINGS_INDEX.insert([
        {
          id: String(result.booking.id),
          values: embedding,
          metadata: {
            user_id: String(result.booking.user_id),
            product_id: String(result.booking.product_id),
            quantity: String(result.booking.quantity),
            product_name: product?.product_name || '',
            status: 'booked',
          },
        },
      ]);

      return Response.json(result, { status: 201 });
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

  // GET /api/bookings/queue/:productId/count - นับจำนวนคิวที่รอ
  const queueCountMatch = url.pathname.match(/^\/api\/bookings\/queue\/(\d+)\/count$/);
  if (queueCountMatch && method === 'GET') {
    try {
      const productId = parseInt(queueCountMatch[1]);
      const count = await queueService.getQueueCount(productId);
      return Response.json({ product_id: productId, waiting_count: count });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // DELETE /api/bookings/queue/:productId/clear - เคลียร์คิวทั้งหมดของสินค้า
  const queueClearMatch = url.pathname.match(/^\/api\/bookings\/queue\/(\d+)\/clear$/);
  if (queueClearMatch && method === 'DELETE') {
    try {
      const productId = parseInt(queueClearMatch[1]);
      const cleared = await queueService.clearQueueByProduct(productId);
      return Response.json({ product_id: productId, cleared_count: cleared, message: `เคลียร์คิวสำเร็จ ${cleared} รายการ` });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // GET /api/bookings/queue/position/:queueId - ดูตำแหน่งคิว
  const queuePosMatch = url.pathname.match(/^\/api\/bookings\/queue\/position\/(\d+)$/);
  if (queuePosMatch && method === 'GET') {
    try {
      const pos = await queueService.getQueuePosition(parseInt(queuePosMatch[1]));
      if (!pos) return Response.json({ error: 'ไม่พบคิวหรือไม่ได้อยู่ในสถานะรอ' }, { status: 404 });
      return Response.json({ data: pos });
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
