import { ProductQueueService } from '../services/ProductQueueService';
import { verifyRequestAuth } from '../utils/auth';

interface Env {
  DB: D1Database;
  USERS_CACHE: KVNamespace;
  JWT_SECRET?: string;
}

export async function handleProductQueueRoutes(request: Request, env: Env, url: URL, method: string): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/product-queue')) return null;

  const productQueueService = new ProductQueueService(env);

  // Auth required for all routes
  const authCheck = await verifyRequestAuth(request, env);
  if (authCheck instanceof Response) return authCheck;

  // POST /api/product-queue/join — เหมือน DO POST /join
  if (url.pathname === '/api/product-queue/join' && method === 'POST') {
    try {
      const body = await request.json<{ userId: number; productId: number; bookingId?: number }>();

      if (!body.userId || !body.productId) {
        return Response.json({ error: 'กรุณาระบุ userId และ productId' }, { status: 400 });
      }

      const result = await productQueueService.join(body.productId, body.userId, body.bookingId);
      return Response.json(result);
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // GET /api/product-queue/status?productId=...&userId=... — เหมือน DO GET /queue/status
  if (url.pathname === '/api/product-queue/status' && method === 'GET') {
    try {
      const productId = url.searchParams.get('productId');
      const userId = url.searchParams.get('userId');

      if (!productId || !userId) {
        return Response.json({ error: 'Missing productId or userId' }, { status: 400 });
      }

      const result = await productQueueService.getQueueStatus(productId, userId);
      return Response.json(result);
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // POST /api/product-queue/leave — เหมือน DO POST /leave
  if (url.pathname === '/api/product-queue/leave' && method === 'POST') {
    try {
      const body = await request.json<{ userId: number; productId: number }>();

      if (!body.userId || !body.productId) {
        return Response.json({ error: 'กรุณาระบุ userId และ productId' }, { status: 400 });
      }

      const result = await productQueueService.leave(body.userId, body.productId);
      return Response.json(result);
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  return null;
}
