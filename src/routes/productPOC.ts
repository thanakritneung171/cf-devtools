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
  const result = await ai.run('@cf/baai/bge-m3', { text: [text] }) as { data: number[][] };
  return result.data[0];
}

async function generateEmbeddings(ai: Ai, texts: string[]): Promise<number[][]> {
  const result = await ai.run('@cf/baai/bge-m3', { text: texts }) as { data: number[][] };
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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
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
      if (body.total_quantity < body.available_quantity) {
        return Response.json({ error: 'total_quantity ต้องไม่น้อยกว่า available_quantity' }, { status: 400 });
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

      if (body.total_quantity !== undefined) {
        const usedQuantity = existing.total_quantity - existing.available_quantity;
        if (body.total_quantity < usedQuantity) {
          return Response.json({
            error: `total_quantity ต้องไม่น้อยกว่าจำนวนที่ถูกใช้ไปแล้ว (${usedQuantity})`,
          }, { status: 400 });
        }
        // คำนวณ available_quantity ใหม่จากจำนวนที่ถูกใช้ไปแล้ว
        body.available_quantity = body.total_quantity - usedQuantity;
      }

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
      const productId = parseInt(idMatch[1]);
      const existing = await service.getById(productId);
      if (!existing) return Response.json({ error: 'ไม่พบสินค้า' }, { status: 404 });

      const body = await request.json<UpdateProductPOCInput>();

      if (body.total_quantity !== undefined) {
        const usedQuantity = existing.total_quantity - existing.available_quantity;
        if (body.total_quantity < usedQuantity) {
          return Response.json({
            error: `total_quantity ต้องไม่น้อยกว่าจำนวนที่ถูกใช้ไปแล้ว (${usedQuantity})`,
          }, { status: 400 });
        }
        body.available_quantity = body.total_quantity - usedQuantity;
      }

      const product = await service.update(productId, body);
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

  // DELETE /api/productPOC/vectors/clear — ลบ vector ทั้งหมดใน index วนจนหมด
  if (url.pathname === '/api/productPOC/vectors/clear' && method === 'DELETE') {
    try {
      let totalDeleted = 0;
      let round = 0;

      // วนลบจนกว่าจะไม่มี vector เหลือ
      while (true) {
        round++;
        // query ด้วย dummy vector เพื่อดึง IDs ที่ยังมีอยู่ (สูงสุด 100 ต่อรอบ)
        const dummyVector = new Array(1024).fill(0);
        dummyVector[0] = 1; // ให้มี direction เพื่อหลีกเลี่ยง zero vector
        const results = await env.PRODUCTS_POC_INDEX.query(dummyVector, { topK: 100 });

        if (!results.matches || results.matches.length === 0) break;

        const idsToDelete = results.matches.map(m => m.id);
        await env.PRODUCTS_POC_INDEX.deleteByIds(idsToDelete);
        totalDeleted += idsToDelete.length;

        // ป้องกัน infinite loop
        if (round > 1000) break;
      }

      return Response.json({ message: 'ลบ vector ทั้งหมดสำเร็จ', total_deleted: totalDeleted, rounds: round });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ลบ vector ไม่สำเร็จ' }, { status: 500 });
    }
  }

  // GET /api/productPOC/vectors/count — นับจำนวน vector ทั้งหมดใน index
  if (url.pathname === '/api/productPOC/vectors/count' && method === 'GET') {
    try {
      const described = await env.PRODUCTS_POC_INDEX.describe();
      return Response.json({
        vector_count: described.vectorsCount,
        config: described.config,
      });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ดึงข้อมูล index ไม่สำเร็จ' }, { status: 500 });
    }
  }

  // POST /api/productPOC/vectors/reindex — ดึงสินค้าทั้งหมดจาก D1 + รูปจาก R2 แล้ว upsert เข้า Vectorize
  if (url.pathname === '/api/productPOC/vectors/reindex' && method === 'POST') {
    try {
      const allProducts = await env.DB.prepare(
        'SELECT p.*, f.file_path FROM productsPOC p LEFT JOIN files f ON p.image_id = f.id'
      ).all<any>();

      const products = allProducts.results || [];
      let success = 0;
      let failed = 0;
      let withImage = 0;
      const errors: { id: number; error: string }[] = [];

      for (const p of products) {
        try {
          let imageBytes: ArrayBuffer | undefined;
          if (p.file_path) {
            const obj = await env.MY_BUCKET.get(p.file_path);
            if (obj) {
              imageBytes = await obj.arrayBuffer();
              withImage++;
            }
          }

          await upsertMultiCaseVectors(env.AI, env.PRODUCTS_POC_INDEX, p.id, {
            product_name: p.product_name,
            description: p.description,
            price: p.price,
            total_quantity: p.total_quantity,
            available_quantity: p.available_quantity,
          }, imageBytes);

          success++;
        } catch (err: any) {
          failed++;
          errors.push({ id: p.id, error: err.message });
        }
      }

      return Response.json({
        message: 'Re-index สำเร็จ',
        total: products.length,
        success,
        failed,
        with_image: withImage,
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (error: any) {
      return Response.json({ error: error.message || 'Re-index ไม่สำเร็จ' }, { status: 500 });
    }
  }

  // GET /api/productPOC/migrate/export — export สินค้าทั้งหมด + รูปเป็น base64 JSON
  if (url.pathname === '/api/productPOC/migrate/export' && method === 'GET') {
    try {
      const allProducts = await env.DB.prepare(
        'SELECT p.*, f.file_path, f.file_name, f.file_type FROM productsPOC p LEFT JOIN files f ON p.image_id = f.id'
      ).all<any>();

      const products = allProducts.results || [];
      const data: any[] = [];

      for (const p of products) {
        const item: any = {
          user_id: p.user_id,
          product_name: p.product_name,
          description: p.description || '',
          price: p.price,
          total_quantity: p.total_quantity,
          available_quantity: p.available_quantity,
        };

        if (p.file_path) {
          const obj = await env.MY_BUCKET.get(p.file_path);
          if (obj) {
            const buffer = await obj.arrayBuffer();
            item.image = {
              file_name: p.file_name || 'image.jpg',
              file_type: p.file_type || 'image/jpeg',
              base64: arrayBufferToBase64(buffer),
            };
          }
        }
        data.push(item);
      }

      return Response.json({ data, total: data.length });
    } catch (error: any) {
      return Response.json({ error: error.message || 'Export ไม่สำเร็จ' }, { status: 500 });
    }
  }

  // POST /api/productPOC/migrate/import — import สินค้าจาก JSON โดยเรียก /api/productPOCimage
  if (url.pathname === '/api/productPOC/migrate/import' && method === 'POST') {
    try {
      const body = await request.json<{ data: any[] }>();
      if (!body.data || !Array.isArray(body.data)) {
        return Response.json({ error: 'กรุณาส่ง { data: [...] }' }, { status: 400 });
      }

      const authHeader = request.headers.get('Authorization') || '';
      const baseUrl = new URL(request.url).origin;
      let success = 0;
      let failed = 0;
      const results: any[] = [];

      for (const item of body.data) {
        try {
          const formData = new FormData();
          formData.append('user_id', String(item.user_id || 1));
          formData.append('product_name', item.product_name);
          formData.append('description', item.description || '');
          formData.append('price', String(item.price));
          formData.append('total_quantity', String(item.total_quantity));
          formData.append('available_quantity', String(item.available_quantity));

          if (item.image?.base64) {
            const buffer = base64ToArrayBuffer(item.image.base64);
            const file = new File([buffer], item.image.file_name || 'image.jpg', {
              type: item.image.file_type || 'image/jpeg',
            });
            formData.append('file', file);
          }

          const res = await fetch(`${baseUrl}/api/productPOCimage`, {
            method: 'POST',
            headers: { Authorization: authHeader },
            body: formData,
          });

          const result = await res.json() as any;
          if (res.ok) {
            success++;
            results.push({ product_name: item.product_name, status: 'success', id: result.id });
          } else {
            failed++;
            results.push({ product_name: item.product_name, status: 'failed', error: result.error });
          }
        } catch (err: any) {
          failed++;
          results.push({ product_name: item.product_name, status: 'failed', error: err.message });
        }
      }

      return Response.json({
        message: 'Import เสร็จสิ้น',
        total: body.data.length,
        success,
        failed,
        results,
      });
    } catch (error: any) {
      return Response.json({ error: error.message || 'Import ไม่สำเร็จ' }, { status: 500 });
    }
  }

  // GET /api/productPOC/vectors/all?page=1&limit=20 — ดึง vector ทั้งหมด พร้อม pagination
  if (url.pathname === '/api/productPOC/vectors/all' && method === 'GET') {
    try {
      const page = parseInt(url.searchParams.get('page') || '1');
      const limit = parseInt(url.searchParams.get('limit') || '20');

      // query ด้วย dummy vector เพื่อดึงทั้งหมด (topK สูงสุดที่ Vectorize รองรับ)
      const dummyVector = new Array(1024).fill(0);
      dummyVector[0] = 1;
      const maxFetch = Math.min(page * limit, 10000);
      const results = await env.PRODUCTS_POC_INDEX.query(dummyVector, {
        topK: maxFetch,
        returnMetadata: 'all',
      });

      const allMatches = results.matches || [];
      const total = allMatches.length;
      const start = (page - 1) * limit;
      const paged = allMatches.slice(start, start + limit);

      const described = await env.PRODUCTS_POC_INDEX.describe();

      return Response.json({
        data: paged.map(m => ({ id: m.id, score: m.score, metadata: m.metadata })),
        pagination: {
          page,
          limit,
          total_fetched: total,
          total_in_index: described.vectorsCount,
          total_pages: Math.ceil(total / limit),
        },
      });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ดึง vector ไม่สำเร็จ' }, { status: 500 });
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

      if (!matches.matches || matches.matches.length === 0) {
        return Response.json({ query: imageDescription, results: [], total: 0 });
      }

      // Limit to topK
      const filtered = matches.matches.slice(0, topK);

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

      return Response.json({ query: imageDescription, results, total: results.length });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ค้นหาด้วยรูปภาพไม่สำเร็จ' }, { status: 500 });
    }
  }

  return null;
}
