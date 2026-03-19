import { ProductPOCService } from '../services/ProductPOCService';
import { FileService } from '../services/FileService';
import { verifyRequestAuth } from '../utils/auth';
import { CreateProductPOCInput, UpdateProductPOCInput } from '../types/productPOC';

interface Env {
  DB: D1Database;
  USERS_CACHE: KVNamespace;
  JWT_SECRET?: string;
  PRODUCTS_POC_INDEX: VectorizeIndex;
  AI: Ai;
  MY_BUCKET: R2Bucket;
  R2_DOMAIN?: string;
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
  // แยก /api/productPOCimage ให้ match ก่อนเช็ค auth เพื่อไม่ให้ชน pattern อื่น

  const service = new ProductPOCService(env);

  // Auth required for all routes
  const authCheck = await verifyRequestAuth(request, env);
  if (authCheck instanceof Response) return authCheck;

  // POST /api/productPOC - สร้างสินค้า (JSON ไม่มีรูป)
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

  // POST /api/productPOCimage - สร้างสินค้าพร้อมอัปโหลดรูป (multipart/form-data)
  if (url.pathname === '/api/productPOCimage' && method === 'POST') {
    try {
      const formData = await request.formData();
      const file = formData.get('file') as File | null;

      const body: CreateProductPOCInput = {
        user_id: parseInt(formData.get('user_id') as string),
        product_name: formData.get('product_name') as string,
        description: (formData.get('description') as string) || undefined,
        price: parseFloat(formData.get('price') as string),
        total_quantity: parseInt(formData.get('total_quantity') as string),
        available_quantity: formData.get('available_quantity')
          ? parseInt(formData.get('available_quantity') as string)
          : parseInt(formData.get('total_quantity') as string),
      };

      if (!body.product_name || isNaN(body.price) || isNaN(body.total_quantity)) {
        return Response.json({ error: 'กรุณากรอก product_name, price, total_quantity' }, { status: 400 });
      }
      if (isNaN(body.available_quantity)) {
        body.available_quantity = body.total_quantity;
      }

      // อัปโหลดรูปผ่าน FileService (ถ้ามี)
      if (file) {
        if (file.size > 10 * 1024 * 1024) {
          return Response.json({ error: 'ไฟล์ขนาดใหญ่เกิน 10MB' }, { status: 400 });
        }
        const fileService = new FileService(env);
        const authPayload = authCheck as any;
        const uploadedFile = await fileService.uploadFile(file, authPayload?.sub ? parseInt(authPayload.sub) : undefined);
        body.image_id = uploadedFile.id;
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

  // GET /api/productPOC/smart-search?q=...&minPrice=...&maxPrice=...&topK=... — smart semantic search with filters
  if (url.pathname === '/api/productPOC/smart-search' && method === 'GET') {
    try {
      const q = url.searchParams.get('q');
      if (!q) return Response.json({ error: 'กรุณาระบุ query parameter q' }, { status: 400 });

      const topK = parseInt(url.searchParams.get('topK') || '10');
      const minPrice = url.searchParams.get('minPrice') ? parseFloat(url.searchParams.get('minPrice')!) : undefined;
      const maxPrice = url.searchParams.get('maxPrice') ? parseFloat(url.searchParams.get('maxPrice')!) : undefined;

      // Generate embedding จาก query text
      const embedding = await generateEmbedding(env.AI, q);

      // Query vectorize with higher topK to allow post-filtering
      const fetchK = Math.min(topK * 3, 50);
      const matches = await env.PRODUCTS_POC_INDEX.query(embedding, {
        topK: fetchK,
        returnMetadata: 'all',
      });

      if (!matches.matches || matches.matches.length === 0) {
        return Response.json({ results: [], total: 0 });
      }

      // Filter by price range from metadata
      let filtered = matches.matches;
      if (minPrice !== undefined || maxPrice !== undefined) {
        filtered = filtered.filter((m) => {
          const price = parseFloat(String(m.metadata?.price || '0'));
          if (minPrice !== undefined && price < minPrice) return false;
          if (maxPrice !== undefined && price > maxPrice) return false;
          return true;
        });
      }

      // Limit to topK after filtering
      filtered = filtered.slice(0, topK);

      if (filtered.length === 0) {
        return Response.json({ results: [], total: 0 });
      }

      // Fetch full product data from D1
      const ids = filtered.map((m) => m.id);
      const placeholders = ids.map(() => '?').join(',');
      const products = await env.DB.prepare(
        `SELECT p.*, f.file_path FROM productsPOC p LEFT JOIN files f ON p.image_id = f.id WHERE p.id IN (${placeholders})`
      )
        .bind(...ids.map(Number))
        .all<any>();

      const r2Domain = env.R2_DOMAIN || 'https://pub-5996ee0506414893a70d525a21960eba.r2.dev';
      const scoreMap = new Map(filtered.map((m) => [m.id, m.score]));
      const results = (products.results ?? [])
        .map((p: any) => {
          const { file_path, ...product } = p;
          if (file_path) product.image_url = `${r2Domain}/${file_path}`;
          return { ...product, score: scoreMap.get(String(p.id)) ?? 0 };
        })
        .sort((a: any, b: any) => b.score - a.score);

      return Response.json({ query: q, results, total: results.length });
    } catch (error: any) {
      return Response.json({ error: error.message || 'Smart search ไม่สำเร็จ' }, { status: 500 });
    }
  }

  // GET /api/productPOC/:id/recommendations?topK=... — สินค้าแนะนำจาก vector similarity
  const recoMatch = url.pathname.match(/^\/api\/productPOC\/(\d+)\/recommendations$/);
  if (recoMatch && method === 'GET') {
    try {
      const productId = parseInt(recoMatch[1]);
      const topK = parseInt(url.searchParams.get('topK') || '5');

      // ดึง vector ของสินค้าต้นทาง
      const vectors = await env.PRODUCTS_POC_INDEX.getByIds([String(productId)]);
      if (!vectors || vectors.length === 0) {
        return Response.json({ error: 'ไม่พบ vector ของสินค้านี้' }, { status: 404 });
      }

      const sourceVector = vectors[0].values;
      if (!sourceVector) {
        return Response.json({ error: 'ไม่พบ embedding ของสินค้านี้' }, { status: 404 });
      }

      // Query หาสินค้าที่คล้ายกัน (topK + 1 เพื่อตัดตัวเองออก)
      const matches = await env.PRODUCTS_POC_INDEX.query(sourceVector, {
        topK: topK + 1,
        returnMetadata: 'all',
      });

      // ตัดสินค้าต้นทางออกจากผลลัพธ์
      const filtered = (matches.matches || []).filter((m) => m.id !== String(productId)).slice(0, topK);

      if (filtered.length === 0) {
        return Response.json({ product_id: productId, recommendations: [], total: 0 });
      }

      // Fetch full product data from D1
      const ids = filtered.map((m) => m.id);
      const placeholders = ids.map(() => '?').join(',');
      const products = await env.DB.prepare(
        `SELECT p.*, f.file_path FROM productsPOC p LEFT JOIN files f ON p.image_id = f.id WHERE p.id IN (${placeholders})`
      )
        .bind(...ids.map(Number))
        .all<any>();

      const r2Domain = env.R2_DOMAIN || 'https://pub-5996ee0506414893a70d525a21960eba.r2.dev';
      const scoreMap = new Map(filtered.map((m) => [m.id, m.score]));
      const recommendations = (products.results ?? [])
        .map((p: any) => {
          const { file_path, ...product } = p;
          if (file_path) product.image_url = `${r2Domain}/${file_path}`;
          return { ...product, similarity_score: scoreMap.get(String(p.id)) ?? 0 };
        })
        .sort((a: any, b: any) => b.similarity_score - a.similarity_score);

      return Response.json({ product_id: productId, recommendations, total: recommendations.length });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ดึงสินค้าแนะนำไม่สำเร็จ' }, { status: 500 });
    }
  }

  // PUT /api/productPOCimage/:id - อัปเดตสินค้าพร้อมรูป (multipart/form-data)
  const updateImageMatch = url.pathname.match(/^\/api\/productPOCimage\/(\d+)$/);
  if (updateImageMatch && method === 'PUT') {
    try {
      const productId = parseInt(updateImageMatch[1]);
      const existing = await service.getById(productId);
      if (!existing) return Response.json({ error: 'ไม่พบสินค้า' }, { status: 404 });

      const formData = await request.formData();
      const file = formData.get('file') as File | null;

      const body: UpdateProductPOCInput = {};
      const productName = formData.get('product_name') as string | null;
      const description = formData.get('description') as string | null;
      const price = formData.get('price') as string | null;
      const totalQuantity = formData.get('total_quantity') as string | null;
      const availableQuantity = formData.get('available_quantity') as string | null;

      if (productName) body.product_name = productName;
      if (description !== null) body.description = description;
      if (price) body.price = parseFloat(price);
      if (totalQuantity) body.total_quantity = parseInt(totalQuantity);
      if (availableQuantity) body.available_quantity = parseInt(availableQuantity);

      // อัปโหลดรูปผ่าน FileService (ถ้ามี)
      if (file) {
        if (file.size > 10 * 1024 * 1024) {
          return Response.json({ error: 'ไฟล์ขนาดใหญ่เกิน 10MB' }, { status: 400 });
        }
        const fileService = new FileService(env);
        const authPayload = authCheck as any;
        const uploadedFile = await fileService.uploadFile(file, authPayload?.sub ? parseInt(authPayload.sub) : undefined);
        body.image_id = uploadedFile.id;
      }

      const product = await service.update(productId, body);
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
      return Response.json({ error: error.message || 'ไม่สามารถอัปเดตสินค้าได้' }, { status: 500 });
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

  // POST /api/productPOC/:id/image - อัปโหลด/เปลี่ยนรูปสินค้า
  const imageMatch = url.pathname.match(/^\/api\/productPOC\/(\d+)\/image$/);
  if (imageMatch && method === 'POST') {
    try {
      const productId = parseInt(imageMatch[1]);
      const existing = await service.getById(productId);
      if (!existing) return Response.json({ error: 'ไม่พบสินค้า' }, { status: 404 });

      const formData = await request.formData();
      const file = formData.get('file') as File | null;
      if (!file) return Response.json({ error: 'กรุณาแนบไฟล์รูปภาพ (field: file)' }, { status: 400 });

      // ตรวจสอบขนาดไฟล์ (max 10MB)
      if (file.size > 10 * 1024 * 1024) {
        return Response.json({ error: 'ไฟล์ขนาดใหญ่เกิน 10MB' }, { status: 400 });
      }

      const fileService = new FileService(env);
      const authPayload = authCheck as any;
      const uploadedFile = await fileService.uploadFile(file, authPayload?.sub ? parseInt(authPayload.sub) : undefined);

      // อัปเดต image_id ในสินค้า
      const product = await service.update(productId, { image_id: uploadedFile.id });

      return Response.json({ product, file: uploadedFile, message: 'อัปโหลดรูปสินค้าสำเร็จ' }, { status: 200 });
    } catch (error: any) {
      return Response.json({ error: error.message || 'อัปโหลดรูปไม่สำเร็จ' }, { status: 500 });
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
