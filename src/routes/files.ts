import { FileService } from '../services/FileService';
import { verifyRequestAuth } from '../utils/auth';

interface Env {
  DB: D1Database;
  MY_BUCKET: R2Bucket;
  USERS_CACHE: KVNamespace;
  R2_DOMAIN?: string;
  JWT_SECRET?: string;
}

export async function handleFileRoutes(request: Request, env: Env, url: URL, method: string): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/files')) return null;

  const service = new FileService(env);

  // Auth required for all routes
  const authCheck = await verifyRequestAuth(request, env);
  if (authCheck instanceof Response) return authCheck;
  const payload = authCheck as Record<string, any>;

  // POST /api/files - อัปโหลดไฟล์
  if (url.pathname === '/api/files' && method === 'POST') {
    try {
      const formData = await request.formData();
      const file = formData.get('file') as File | null;

      if (!file) {
        return Response.json({ error: 'กรุณาระบุไฟล์' }, { status: 400 });
      }

      if (file.size > 10 * 1024 * 1024) {
        return Response.json({ error: 'ขนาดไฟล์ต้องน้อยกว่า 10MB' }, { status: 400 });
      }

      const uploadedBy = payload.sub ? parseInt(payload.sub) : undefined;
      const record = await service.uploadFile(file, uploadedBy);
      return Response.json(record, { status: 201 });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ไม่สามารถอัปโหลดไฟล์ได้' }, { status: 500 });
    }
  }

  // GET /api/files - ดูรายการไฟล์
  if (url.pathname === '/api/files' && method === 'GET') {
    try {
      const page = parseInt(url.searchParams.get('page') || '1');
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const result = await service.getFiles(page, limit);
      return Response.json({
        data: result.data,
        pagination: { page, limit, total: result.total, total_pages: Math.ceil(result.total / limit) },
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // GET /api/files/:id/download - ดาวน์โหลดไฟล์จาก R2
  const downloadMatch = url.pathname.match(/^\/api\/files\/(\d+)\/download$/);
  if (downloadMatch && method === 'GET') {
    try {
      const result = await service.downloadFile(parseInt(downloadMatch[1]));
      if (!result) return Response.json({ error: 'ไม่พบไฟล์' }, { status: 404 });

      const headers = new Headers();
      headers.set('Content-Type', result.object.httpMetadata?.contentType || 'application/octet-stream');
      headers.set('Content-Disposition', `attachment; filename="${result.file.file_name}"`);

      return new Response(result.object.body, { headers });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // GET /api/files/:id - ดูข้อมูลไฟล์
  const idMatch = url.pathname.match(/^\/api\/files\/(\d+)$/);
  if (idMatch && method === 'GET') {
    try {
      const file = await service.getById(parseInt(idMatch[1]));
      if (!file) return Response.json({ error: 'ไม่พบไฟล์' }, { status: 404 });
      return Response.json(file);
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // DELETE /api/files/:id
  if (idMatch && method === 'DELETE') {
    try {
      const success = await service.deleteFile(parseInt(idMatch[1]));
      if (!success) return Response.json({ error: 'ไม่พบไฟล์' }, { status: 404 });
      return Response.json({ message: 'ลบไฟล์สำเร็จ' });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  return null;
}
