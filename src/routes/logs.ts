import { LogService } from '../services/LogService';
import { verifyRequestAuth } from '../utils/auth';

interface Env {
  DB: D1Database;
  USERS_CACHE: KVNamespace;
  JWT_SECRET?: string;
}

export async function handleLogRoutes(request: Request, env: Env, url: URL, method: string): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/logs')) return null;

  const service = new LogService(env);

  // Auth required for all routes
  const authCheck = await verifyRequestAuth(request, env);
  if (authCheck instanceof Response) return authCheck;

  // GET /api/logs - ดู logs
  if (url.pathname === '/api/logs' && method === 'GET') {
    try {
      const page = parseInt(url.searchParams.get('page') || '1');
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const logType = url.searchParams.get('log_type') || undefined;
      const result = await service.getLogs(page, limit, logType);
      return Response.json({
        data: result.data,
        pagination: { page, limit, total: result.total, total_pages: Math.ceil(result.total / limit) },
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // GET /api/logs/:id
  const idMatch = url.pathname.match(/^\/api\/logs\/(\d+)$/);
  if (idMatch && method === 'GET') {
    try {
      const log = await service.getById(parseInt(idMatch[1]));
      if (!log) return Response.json({ error: 'ไม่พบ log' }, { status: 404 });
      return Response.json(log);
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // DELETE /api/logs/:id
  if (idMatch && method === 'DELETE') {
    try {
      const success = await service.delete(parseInt(idMatch[1]));
      if (!success) return Response.json({ error: 'ไม่พบ log' }, { status: 404 });
      return Response.json({ message: 'ลบ log สำเร็จ' });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  return null;
}
