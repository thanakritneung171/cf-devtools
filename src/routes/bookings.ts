import { BookingService } from '../services/BookingService';
import { QueueService } from '../services/QueueService';
import { verifyRequestAuth } from '../utils/auth';
import { CreateBookingInput } from '../types/productPOC';

interface Env {
  DB: D1Database;
  USERS_CACHE: KVNamespace;
  JWT_SECRET?: string;
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
      return Response.json(result, { status: 201 });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
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
      const booking = await bookingService.cancelBooking(parseInt(cancelMatch[1]));
      if (!booking) return Response.json({ error: 'ไม่พบการจองหรือถูกยกเลิกแล้ว' }, { status: 404 });
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
