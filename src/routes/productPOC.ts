import { ProductPOCService } from '../services/ProductPOCService';
import { verifyRequestAuth } from '../utils/auth';
import { CreateProductPOCInput, UpdateProductPOCInput } from '../types/productPOC';

interface Env {
  DB: D1Database;
  USERS_CACHE: KVNamespace;
  JWT_SECRET?: string;
  PRODUCTS_POC_INDEX: VectorizeIndex;
  AI: Ai;
}

function buildProductPOCEmbedText(p: { product_name: string; description?: string; price: number }): string {
  return `${p.product_name} ${p.description || ''} price:${p.price}`;
}

async function generateEmbedding(ai: Ai, text: string): Promise<number[]> {
  const result = await ai.run('@cf/baai/bge-base-en-v1.5', { text: [text] }) as { data: number[][] };
  return result.data[0];
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

      // สร้าง Vectorize embedding
      const embedText = buildProductPOCEmbedText(body);
      const embedding = await generateEmbedding(env.AI, embedText);
      await env.PRODUCTS_POC_INDEX.insert([
        {
          id: String(product.id),
          values: embedding,
          metadata: {
            product_name: body.product_name,
            description: body.description || '',
            price: String(body.price),
          },
        },
      ]);

      return Response.json(product, { status: 201 });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ไม่สามารถสร้างสินค้าได้' }, { status: 500 });
    }
  }

  // GET /api/productPOC/search/fast?q=... — semantic search (metadata only)
  if (url.pathname === '/api/productPOC/search/fast' && method === 'GET') {
    try {
      const q = url.searchParams.get('q');
      if (!q) return Response.json({ error: 'กรุณาระบุ query parameter q' }, { status: 400 });

      const topK = parseInt(url.searchParams.get('topK') || '5');
      const embedding = await generateEmbedding(env.AI, q);
      const matches = await env.PRODUCTS_POC_INDEX.query(embedding, {
        topK,
        returnMetadata: 'all',
        returnValues: true,
      });

      return Response.json({ matches });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ค้นหาไม่สำเร็จ' }, { status: 500 });
    }
  }

  // GET /api/productPOC/search?q=... — semantic search + D1 data
  if (url.pathname === '/api/productPOC/search' && method === 'GET') {
    try {
      const q = url.searchParams.get('q');
      if (!q) return Response.json({ error: 'กรุณาระบุ query parameter q' }, { status: 400 });

      const topK = parseInt(url.searchParams.get('topK') || '5');
      const embedding = await generateEmbedding(env.AI, q);
      const matches = await env.PRODUCTS_POC_INDEX.query(embedding, {
        topK,
        returnMetadata: 'all',
      });

      if (!matches.matches || matches.matches.length === 0) {
        return Response.json({ results: [] });
      }

      const ids = matches.matches.map((m) => m.id);
      const placeholders = ids.map(() => '?').join(',');
      const products = await env.DB.prepare(
        `SELECT * FROM productsPOC WHERE id IN (${placeholders})`
      )
        .bind(...ids.map(Number))
        .all();

      const scoreMap = new Map(matches.matches.map((m) => [m.id, m.score]));
      const results = (products.results ?? [])
        .map((p: any) => ({ ...p, score: scoreMap.get(String(p.id)) ?? 0 }))
        .sort((a: any, b: any) => b.score - a.score);

      return Response.json({ results });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ค้นหาไม่สำเร็จ' }, { status: 500 });
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

      // อัปเดต Vectorize embedding
      const embedText = buildProductPOCEmbedText({
        product_name: product.product_name,
        description: product.description,
        price: product.price,
      });
      const embedding = await generateEmbedding(env.AI, embedText);
      await env.PRODUCTS_POC_INDEX.upsert([
        {
          id: String(product.id),
          values: embedding,
          metadata: {
            product_name: product.product_name,
            description: product.description || '',
            price: String(product.price),
          },
        },
      ]);

      return Response.json(product);
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // DELETE /api/productPOC/:id
  if (idMatch && method === 'DELETE') {
    try {
      const productId = parseInt(idMatch[1]);
      const success = await service.delete(productId);
      if (!success) return Response.json({ error: 'ไม่พบสินค้า' }, { status: 404 });

      // ลบ vector จาก Vectorize
      await env.PRODUCTS_POC_INDEX.deleteByIds([String(productId)]);

      return Response.json({ message: 'ลบสินค้าสำเร็จ' });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  return null;
}
