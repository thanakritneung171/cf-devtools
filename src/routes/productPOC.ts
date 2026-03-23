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

function buildProductPOCEmbedText(p: { product_name: string; description?: string;  }): string {
  return `${p.product_name} ${p.description || ''}`.trim();
}

interface EmbedCase {
  caseNumber: number;
  text: string;
}

function buildEmbedCases(p: {
  product_name: string;
  description?: string;
  price: number;
  total_quantity: number;
  available_quantity: number;
}): EmbedCase[] {
  return [
    { caseNumber: 1, text: `${p.product_name} ${p.description || ''}`.trim() },
    { caseNumber: 2, text: `${p.product_name} ${p.description || ''} ${p.price}`.trim() },
    { caseNumber: 3, text: p.product_name },
    { caseNumber: 4, text: p.description || '' },
    { caseNumber: 5, text: String(p.total_quantity) },
    { caseNumber: 6, text: String(p.available_quantity) },
    { caseNumber: 7, text: String(p.price) },
  ].filter(c => c.text.length > 0);
}

async function generateEmbedding(ai: Ai, text: string): Promise<number[]> {
  const result = await ai.run('@cf/baai/bge-base-en-v1.5', { text: [text] }) as { data: number[][] };
  return result.data[0];
}

async function generateEmbeddings(ai: Ai, texts: string[]): Promise<number[][]> {
  const result = await ai.run('@cf/baai/bge-base-en-v1.5', { text: texts }) as { data: number[][] };
  return result.data;
}

async function describeImageWithVision(ai: Ai, imageBytes: ArrayBuffer): Promise<string> {
  const result = await ai.run('@cf/llava-hf/llava-1.5-7b-hf', {
    image: [...new Uint8Array(imageBytes)],
    prompt: 'Describe this product image in detail for search indexing.',
    max_tokens: 256,
  }) as any;
  return result.description || result.response || '';
}

async function insertMultiCaseVectors(
  ai: Ai, index: VectorizeIndex, productId: number,
  product: { product_name: string; description?: string; price: number; total_quantity: number; available_quantity: number },
  imageBytes?: ArrayBuffer,
): Promise<void> {
  const cases = buildEmbedCases(product);
  const embeddings = await generateEmbeddings(ai, cases.map(c => c.text));
  const vectors: VectorizeVector[] = cases.map((c, i) => ({
    id: `${productId}_case${c.caseNumber}`,
    values: embeddings[i],
    metadata: { product_name: product.product_name, embed_case: c.caseNumber },
  }));

  if (imageBytes) {
    const desc = await describeImageWithVision(ai, imageBytes);
    if (desc.trim()) {
      const imgEmb = await generateEmbedding(ai, desc);
      vectors.push({
        id: `${productId}_case8`,
        values: imgEmb,
        metadata: { product_name: product.product_name, embed_case: 8, image_description: desc },
      });
    }
  }
  await index.insert(vectors);
}

async function upsertMultiCaseVectors(
  ai: Ai, index: VectorizeIndex, productId: number,
  product: { product_name: string; description?: string; price: number; total_quantity: number; available_quantity: number },
  imageBytes?: ArrayBuffer,
): Promise<void> {
  const cases = buildEmbedCases(product);
  const embeddings = await generateEmbeddings(ai, cases.map(c => c.text));
  const vectors: VectorizeVector[] = cases.map((c, i) => ({
    id: `${productId}_case${c.caseNumber}`,
    values: embeddings[i],
    metadata: { product_name: product.product_name, embed_case: c.caseNumber },
  }));

  if (imageBytes) {
    const desc = await describeImageWithVision(ai, imageBytes);
    if (desc.trim()) {
      const imgEmb = await generateEmbedding(ai, desc);
      vectors.push({
        id: `${productId}_case8`,
        values: imgEmb,
        metadata: { product_name: product.product_name, embed_case: 8, image_description: desc },
      });
    }
  }
  await index.upsert(vectors);
}

function buildCaseAnalysis(matches: VectorizeMatches) {
  const byCaseMap: Record<number, any[]> = {};
  for (const m of matches.matches || []) {
    const caseNum = Number(m.metadata?.embed_case || 0);
    if (!byCaseMap[caseNum]) byCaseMap[caseNum] = [];
    byCaseMap[caseNum].push({ id: m.id, score: m.score, product_name: m.metadata?.product_name, embed_case: caseNum });
  }
  const caseStats = Object.entries(byCaseMap).map(([caseNum, items]) => ({
    embed_case: Number(caseNum),
    count: items.length,
    avg_score: +(items.reduce((s, i) => s + i.score, 0) / items.length).toFixed(4),
    max_score: +Math.max(...items.map(i => i.score)).toFixed(4),
    top_match: items.sort((a, b) => b.score - a.score)[0],
  })).sort((a, b) => b.max_score - a.max_score);
  return { caseStats, rawMatches: (matches.matches || []).map(m => ({ id: m.id, score: m.score, metadata: m.metadata })) };
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

      // สร้าง Vectorize embedding (8 cases)
      await insertMultiCaseVectors(env.AI, env.PRODUCTS_POC_INDEX, product.id, {
        product_name: body.product_name, description: body.description,
        price: body.price, total_quantity: body.total_quantity, available_quantity: body.available_quantity,
      });

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

      // อ่าน image bytes ก่อน upload (สำหรับ vector case 8)
      let imageBytes: ArrayBuffer | undefined;
      if (file) {
        if (file.size > 10 * 1024 * 1024) {
          return Response.json({ error: 'ไฟล์ขนาดใหญ่เกิน 10MB' }, { status: 400 });
        }
        imageBytes = await file.arrayBuffer();
        const fileClone = new File([imageBytes], file.name, { type: file.type });
        const fileService = new FileService(env);
        const authPayload = authCheck as any;
        const uploadedFile = await fileService.uploadFile(fileClone, authPayload?.sub ? parseInt(authPayload.sub) : undefined);
        body.image_id = uploadedFile.id;
      }

      const product = await service.create(body);

      // สร้าง Vectorize embedding (8 cases, case 8 เฉพาะเมื่อมีรูป)
      await insertMultiCaseVectors(env.AI, env.PRODUCTS_POC_INDEX, product.id, {
        product_name: body.product_name, description: body.description,
        price: body.price, total_quantity: body.total_quantity, available_quantity: body.available_quantity,
      }, imageBytes);

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

      // Fetch full product data from D1 (แยก product ID จาก vector ID: {id}_case{N})
      const productIds = [...new Set(filtered.map((m) => m.id.split('_case')[0]))];
      const placeholders = productIds.map(() => '?').join(',');
      const products = await env.DB.prepare(
        `SELECT p.*, f.file_path FROM productsPOC p LEFT JOIN files f ON p.image_id = f.id WHERE p.id IN (${placeholders})`
      )
        .bind(...productIds.map(Number))
        .all<any>();

      const r2Domain = env.R2_DOMAIN || 'https://pub-5996ee0506414893a70d525a21960eba.r2.dev';
      const bestScoreMap = new Map<string, number>();
      for (const m of filtered) {
        const pid = m.id.split('_case')[0];
        const prev = bestScoreMap.get(pid) ?? 0;
        if (m.score > prev) bestScoreMap.set(pid, m.score);
      }
      const results = (products.results ?? [])
        .map((p: any) => {
          const { file_path, ...product } = p;
          if (file_path) product.image_url = `${r2Domain}/${file_path}`;
          return { ...product, score: bestScoreMap.get(String(p.id)) ?? 0 };
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

      // ดึง vector ของสินค้าต้นทาง (ใช้ case1)
      const vectors = await env.PRODUCTS_POC_INDEX.getByIds([`${productId}_case1`]);
      if (!vectors || vectors.length === 0) {
        return Response.json({ error: 'ไม่พบ vector ของสินค้านี้' }, { status: 404 });
      }

      const sourceVector = vectors[0].values;
      if (!sourceVector) {
        return Response.json({ error: 'ไม่พบ embedding ของสินค้านี้' }, { status: 404 });
      }

      // Query หาสินค้าที่คล้ายกัน (เพิ่ม topK เพราะแต่ละสินค้ามีหลาย case)
      const matches = await env.PRODUCTS_POC_INDEX.query(sourceVector, {
        topK: (topK + 1) * 8,
        returnMetadata: 'all',
      });

      // ตัดสินค้าต้นทางออก + deduplicate ตาม product ID
      const seenProducts = new Set<string>();
      const deduped: typeof matches.matches = [];
      for (const m of matches.matches || []) {
        const pid = m.id.split('_case')[0];
        if (pid === String(productId)) continue;
        if (seenProducts.has(pid)) continue;
        seenProducts.add(pid);
        deduped.push(m);
        if (deduped.length >= topK) break;
      }

      if (deduped.length === 0) {
        return Response.json({ product_id: productId, recommendations: [], total: 0 });
      }

      // Fetch full product data from D1
      const recProductIds = deduped.map((m) => m.id.split('_case')[0]);
      const placeholders = recProductIds.map(() => '?').join(',');
      const products = await env.DB.prepare(
        `SELECT p.*, f.file_path FROM productsPOC p LEFT JOIN files f ON p.image_id = f.id WHERE p.id IN (${placeholders})`
      )
        .bind(...recProductIds.map(Number))
        .all<any>();

      const r2Domain = env.R2_DOMAIN || 'https://pub-5996ee0506414893a70d525a21960eba.r2.dev';
      const scoreMap = new Map(deduped.map((m) => [m.id.split('_case')[0], m.score]));
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

      // อัปโหลดรูปผ่าน FileService (ถ้ามี) + เก็บ imageBytes สำหรับ vector case 8
      let imageBytes: ArrayBuffer | undefined;
      if (file) {
        if (file.size > 10 * 1024 * 1024) {
          return Response.json({ error: 'ไฟล์ขนาดใหญ่เกิน 10MB' }, { status: 400 });
        }
        imageBytes = await file.arrayBuffer();
        const fileClone = new File([imageBytes], file.name, { type: file.type });
        const fileService = new FileService(env);
        const authPayload = authCheck as any;
        const uploadedFile = await fileService.uploadFile(fileClone, authPayload?.sub ? parseInt(authPayload.sub) : undefined);
        body.image_id = uploadedFile.id;
      }

      const product = await service.update(productId, body);
      if (!product) return Response.json({ error: 'ไม่พบสินค้า' }, { status: 404 });

      // อัปเดต Vectorize embedding (8 cases)
      await upsertMultiCaseVectors(env.AI, env.PRODUCTS_POC_INDEX, product.id, {
        product_name: product.product_name, description: product.description,
        price: product.price, total_quantity: product.total_quantity, available_quantity: product.available_quantity,
      }, imageBytes);

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

      // Deduplicate ตาม product ID (แยกจาก vector ID: {id}_case{N})
      const bestScoreMap2 = new Map<string, number>();
      for (const m of matches.matches) {
        const pid = m.id.split('_case')[0];
        const prev = bestScoreMap2.get(pid) ?? 0;
        if (m.score > prev) bestScoreMap2.set(pid, m.score);
      }
      const productIds2 = [...bestScoreMap2.keys()];
      const placeholders = productIds2.map(() => '?').join(',');
      const products = await env.DB.prepare(
        `SELECT * FROM productsPOC WHERE id IN (${placeholders})`
      )
        .bind(...productIds2.map(Number))
        .all();

      const results = (products.results ?? [])
        .map((p: any) => ({ ...p, score: bestScoreMap2.get(String(p.id)) ?? 0 }))
        .sort((a: any, b: any) => b.score - a.score);

      return Response.json({ results });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ค้นหาไม่สำเร็จ' }, { status: 500 });
    }
  }

  // POST /api/productPOC/filter — filter ตรงจาก D1
  // Body: { product_name?, min_price?, max_price?, page?, limit? }
  if (url.pathname === '/api/productPOC/filter' && method === 'POST') {
    try {
      const body = await request.json<{ product_name?: string; min_price?: number; max_price?: number; page?: number; limit?: number }>();
      const productName = body.product_name || undefined;
      const minPrice = body.min_price !== undefined ? body.min_price : undefined;
      const maxPrice = body.max_price !== undefined ? body.max_price : undefined;
      const page = body.page || 1;
      const limit = body.limit || 10;

      let query = `SELECT p.*, f.file_path FROM productsPOC p LEFT JOIN files f ON p.image_id = f.id WHERE 1=1`;
      let countQuery = 'SELECT COUNT(*) as count FROM productsPOC p WHERE 1=1';
      const params: any[] = [];
      const countParams: any[] = [];

      if (productName) {
        query += ' AND p.product_name LIKE ?';
        countQuery += ' AND p.product_name LIKE ?';
        params.push(`%${productName}%`);
        countParams.push(`%${productName}%`);
      }
      if (minPrice !== undefined) {
        query += ' AND p.price >= ?';
        countQuery += ' AND p.price >= ?';
        params.push(minPrice);
        countParams.push(minPrice);
      }
      if (maxPrice !== undefined) {
        query += ' AND p.price <= ?';
        countQuery += ' AND p.price <= ?';
        params.push(maxPrice);
        countParams.push(maxPrice);
      }

      const countResult = await env.DB.prepare(countQuery).bind(...countParams).first<{ count: number }>();
      const total = countResult?.count || 0;

      const offset = (page - 1) * limit;
      query += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const results = await env.DB.prepare(query).bind(...params).all<any>();
      const r2Domain = env.R2_DOMAIN || 'https://pub-5996ee0506414893a70d525a21960eba.r2.dev';
      const data = (results.results || []).map((p: any) => {
        const { file_path, ...product } = p;
        if (file_path) product.image_url = `${r2Domain}/${file_path}`;
        return product;
      });

      return Response.json({
        data,
        pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
      });
    } catch (error: any) {
      return Response.json({ error: error.message || 'กรองข้อมูลไม่สำเร็จ' }, { status: 500 });
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

      // อัปเดต Vectorize embedding (8 cases)
      await upsertMultiCaseVectors(env.AI, env.PRODUCTS_POC_INDEX, product.id, {
        product_name: product.product_name, description: product.description,
        price: product.price, total_quantity: product.total_quantity, available_quantity: product.available_quantity,
      });

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

      // ลบ vector ทุก case จาก Vectorize
      const caseIds = Array.from({ length: 8 }, (_, i) => `${productId}_case${i + 1}`);
      await env.PRODUCTS_POC_INDEX.deleteByIds(caseIds);

      return Response.json({ message: 'ลบสินค้าสำเร็จ' });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // DELETE /api/productPOC/vectors/clear — ลบ vector ทั้งหมดใน index แล้ว re-index จาก DB
  if (url.pathname === '/api/productPOC/vectors/clear' && method === 'DELETE') {
    try {
      // ดึงสินค้าทั้งหมดจาก DB
      const allProducts = await env.DB.prepare('SELECT id FROM productsPOC').all<{ id: number }>();
      const ids = (allProducts.results || []).map(p => p.id);

      // สร้าง vector IDs ทั้งหมด (8 cases ต่อสินค้า)
      const allVectorIds: string[] = [];
      for (const id of ids) {
        for (let c = 1; c <= 8; c++) {
          allVectorIds.push(`${id}_case${c}`);
        }
        // รองรับ vector ID เก่าที่ไม่มี _case ด้วย
        allVectorIds.push(String(id));
      }

      // ลบทีละ batch (Vectorize รองรับสูงสุด 1000 IDs ต่อ call)
      const batchSize = 1000;
      let deleted = 0;
      for (let i = 0; i < allVectorIds.length; i += batchSize) {
        const batch = allVectorIds.slice(i, i + batchSize);
        await env.PRODUCTS_POC_INDEX.deleteByIds(batch);
        deleted += batch.length;
      }

      return Response.json({ message: 'ลบ vector ทั้งหมดสำเร็จ', vector_ids_cleared: deleted, products_count: ids.length });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ลบ vector ไม่สำเร็จ' }, { status: 500 });
    }
  }

  // GET /api/productPOC/search/test?q=...&topK=20 — ค้นหาด้วย text เปรียบเทียบ embed case
  if (url.pathname === '/api/productPOC/search/test' && method === 'GET') {
    try {
      const q = url.searchParams.get('q');
      if (!q) return Response.json({ error: 'กรุณาระบุ query parameter q' }, { status: 400 });

      const topK = parseInt(url.searchParams.get('topK') || '20');
      const embedding = await generateEmbedding(env.AI, q);
      const matches = await env.PRODUCTS_POC_INDEX.query(embedding, { topK, returnMetadata: 'all' });
      const { caseStats, rawMatches } = buildCaseAnalysis(matches);

      return Response.json({ query: q, total_matches: rawMatches.length, case_analysis: caseStats, raw_matches: rawMatches });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ค้นหาไม่สำเร็จ' }, { status: 500 });
    }
  }

  // POST /api/productPOC/search/image — ค้นหาด้วยรูปภาพ (multipart form-data)
  if (url.pathname === '/api/productPOC/search/image' && method === 'POST') {
    try {
      const formData = await request.formData();
      const file = formData.get('file') as File | null;
      if (!file) return Response.json({ error: 'กรุณาแนบไฟล์รูปภาพ (field: file)' }, { status: 400 });

      const topK = parseInt(formData.get('topK') as string || '20');
      const imageBytes = await file.arrayBuffer();
      const imageDescription = await describeImageWithVision(env.AI, imageBytes);
      if (!imageDescription.trim()) {
        return Response.json({ error: 'ไม่สามารถอธิบายรูปภาพได้' }, { status: 500 });
      }

      const embedding = await generateEmbedding(env.AI, imageDescription);
      const matches = await env.PRODUCTS_POC_INDEX.query(embedding, { topK, returnMetadata: 'all' });

      const rawMatches = (matches.matches || []).map(m => ({ id: m.id, score: m.score, metadata: m.metadata }));
      return Response.json({ image_description: imageDescription, total_matches: rawMatches.length, raw_matches: rawMatches });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ค้นหาด้วยรูปภาพไม่สำเร็จ' }, { status: 500 });
    }
  }

  return null;
}
