import { ProductPOCService } from '../services/ProductPOCService';
import { verifyRequestAuth } from '../utils/auth';
import { CreateProductPOCInput, UpdateProductPOCInput } from '../types/productPOC';

interface Env {
  DB: D1Database;
  USERS_CACHE: KVNamespace;
  JWT_SECRET?: string;
}

export async function handleProductPOCRoutes(request: Request, env: Env, url: URL, method: string): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/productPOC')) return null;

  const service = new ProductPOCService(env);

  // Auth required for all routes
  const authCheck = await verifyRequestAuth(request, env);
  if (authCheck instanceof Response) return authCheck;

  // POST /api/productPOC - สร้างสินค้า
  if (url.pathname === '/api/productPOC' && method === 'POST') {
    try {
      const body = await request.json<CreateProductPOCInput>();
      if (!body.product_name || body.price === undefined || body.total_quantity === undefined) {
        return Response.json({ error: 'กรุณากรอก product_name, price, total_quantity' }, { status: 400 });
      }
      if (body.available_quantity === undefined) {
        body.available_quantity = body.total_quantity;
      }
      const product = await service.create(body);
      return Response.json(product, { status: 201 });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ไม่สามารถสร้างสินค้าได้' }, { status: 500 });
    }
  }

  // GET /api/productPOC - ดูสินค้าทั้งหมด
  if (url.pathname === '/api/productPOC' && method === 'GET') {
    try {
      const page = parseInt(url.searchParams.get('page') || '1');
      const limit = parseInt(url.searchParams.get('limit') || '10');
      const search = url.searchParams.get('search') || undefined;
      const result = await service.getAll(page, limit, search);
      return Response.json({
        data: result.data,
        pagination: { page, limit, total: result.total, total_pages: Math.ceil(result.total / limit) },
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // GET /api/productPOC/:id
  const idMatch = url.pathname.match(/^\/api\/productPOC\/(\d+)$/);
  if (idMatch && method === 'GET') {
    try {
      const product = await service.getById(parseInt(idMatch[1]));
      if (!product) return Response.json({ error: 'ไม่พบสินค้า' }, { status: 404 });
      return Response.json(product);
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // PUT /api/productPOC/:id
  if (idMatch && method === 'PUT') {
    try {
      const body = await request.json<UpdateProductPOCInput>();
      const product = await service.update(parseInt(idMatch[1]), body);
      if (!product) return Response.json({ error: 'ไม่พบสินค้า' }, { status: 404 });
      return Response.json(product);
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // DELETE /api/productPOC/:id
  if (idMatch && method === 'DELETE') {
    try {
      const success = await service.delete(parseInt(idMatch[1]));
      if (!success) return Response.json({ error: 'ไม่พบสินค้า' }, { status: 404 });
      return Response.json({ message: 'ลบสินค้าสำเร็จ' });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  return null;
}
