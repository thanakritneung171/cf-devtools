interface Env {
  DB: D1Database;
  PRODUCTS_INDEX: VectorizeIndex;
  AI: Ai;
}

interface Product {
  id: number;
  name: string;
  description: string;
  price: number;
  category: string;
  stock: number;
  image_url: string | null;
  created_at: string;
}

interface CreateProductBody {
  name: string;
  description: string;
  price: number;
  category: string;
  stock?: number;
  image_url?: string;
}

// Generate a text representation for embedding
function buildEmbedText(p: { name: string; description: string; category: string }): string {
  return `${p.name} ${p.category} ${p.description}`;
}

async function generateEmbedding(ai: Ai, text: string): Promise<number[]> {
  const result = await ai.run('@cf/baai/bge-base-en-v1.5', { text: [text] }) as { data: number[][] };
  return result.data[0];
}

export async function handleProductRoutes(
  request: Request,
  env: Env,
  url: URL,
  method: string
): Promise<Response | null> {

  // POST /products — insert product into D1, generate embedding, store in Vectorize
  if (url.pathname === '/products' && method === 'POST') {
    try {
      const body = await request.json<CreateProductBody>();

      if (!body.name || !body.description || body.price == null || !body.category) {
        return Response.json(
          { error: 'กรุณาระบุ name, description, price, category' },
          { status: 400 }
        );
      }

      // 1. Insert into D1
      const { meta } = await env.DB.prepare(
        `INSERT INTO products (name, description, price, category, stock, image_url)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          body.name,
          body.description,
          body.price,
          body.category,
          body.stock ?? 0,
          body.image_url ?? null
        )
        .run();

      const productId = meta.last_row_id as number;

      // 2. Generate embedding via Workers AI
      const embedText = buildEmbedText(body);
      const embedding = await generateEmbedding(env.AI, embedText);
console.log('Generated embedding for product:', embedding);
      // 3. Store vector in Vectorize (ID = D1 row id as string)
      await env.PRODUCTS_INDEX.insert([
        {
          id: String(productId),
          values: embedding,
          metadata: {
            name: body.name,
            description: body.description,
            category: body.category,
            price: String(body.price),
          },
        },
      ]);

      // 4. Return the created product
      const product = await env.DB.prepare(
        'SELECT * FROM products WHERE id = ?'
      )
        .bind(productId)
        .first<Product>();

      return Response.json(product, { status: 201 });
    } catch (error: any) {
      return Response.json({ error: error.message || 'สร้างสินค้าไม่สำเร็จ' }, { status: 500 });
    }
  }

  // GET /products/search/fast?q=... — semantic search, return Vectorize metadata only (no D1)
  if (url.pathname === '/products/search/fast' && method === 'GET') {
    try {
      const q = url.searchParams.get('q');
      if (!q) {
        return Response.json({ error: 'กรุณาระบุ query parameter q' }, { status: 400 });
      }

      const topK = parseInt(url.searchParams.get('topK') || '5');
      const embedding = await generateEmbedding(env.AI, q);
      const matches = await env.PRODUCTS_INDEX.query(embedding, {
        topK,
        returnMetadata: 'all',
      });
console.log('Vectorize matches (fast search):', matches);
      // const results = (matches.matches ?? []).map((m) => ({
      //   id: m.id,
      //   score: m.score,
      //   ...((m.metadata as Record<string, string>) ?? {}),
      // }));

      // return Response.json({ results });
      return Response.json({matches: matches,});
    } catch (error: any) {
      return Response.json({ error: error.message || 'ค้นหาไม่สำเร็จ' }, { status: 500 });
    }
  }

  // GET /products/search?q=... — semantic search via Vectorize + Workers AI
  if (url.pathname === '/products/search' && method === 'GET') {
    try {
      const q = url.searchParams.get('q');
      if (!q) {
        return Response.json({ error: 'กรุณาระบุ query parameter q' }, { status: 400 });
      }
console.log('Search query:', q);
      const topK = parseInt(url.searchParams.get('topK') || '5');

      // 1. Embed the search query
      const embedding = await generateEmbedding(env.AI, q);

      // 2. Query Vectorize
      const matches = await env.PRODUCTS_INDEX.query(embedding, {
        topK,
        returnMetadata: 'all',
      });
console.log('Vectorize matches:', matches);
      if (!matches.matches || matches.matches.length === 0) {
        return Response.json({ results: [] });
      }

      // 3. Fetch matching products from D1
      const ids = matches.matches.map((m) => m.id);
      const placeholders = ids.map(() => '?').join(',');
      const products = await env.DB.prepare(
        `SELECT * FROM products WHERE id IN (${placeholders})`
      )
        .bind(...ids.map(Number))
        .all<Product>();

      // 4. Attach similarity score to each product
      const scoreMap = new Map(matches.matches.map((m) => [m.id, m.score]));
      const results = (products.results ?? [])
        .map((p) => ({ ...p, score: scoreMap.get(String(p.id)) ?? 0 }))
        .sort((a, b) => b.score - a.score);

      return Response.json({ results });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ค้นหาไม่สำเร็จ' }, { status: 500 });
    }
  }

  // GET /products — list all products (with pagination)
  if (url.pathname === '/products' && method === 'GET') {
    try {
      const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
      const limit = Math.min(100, parseInt(url.searchParams.get('limit') || '20'));
      const offset = (page - 1) * limit;
      const category = url.searchParams.get('category');

      let query: string;
      let countQuery: string;
      const binds: (string | number)[] = [];
      const countBinds: (string | number)[] = [];

      if (category) {
        query = 'SELECT * FROM products WHERE category = ? ORDER BY created_at DESC LIMIT ? OFFSET ?';
        countQuery = 'SELECT COUNT(*) as total FROM products WHERE category = ?';
        binds.push(category, limit, offset);
        countBinds.push(category);
      } else {
        query = 'SELECT * FROM products ORDER BY created_at DESC LIMIT ? OFFSET ?';
        countQuery = 'SELECT COUNT(*) as total FROM products';
        binds.push(limit, offset);
      }

      const [products, countResult] = await Promise.all([
        env.DB.prepare(query).bind(...binds).all<Product>(),
        env.DB.prepare(countQuery).bind(...countBinds).first<{ total: number }>(),
      ]);

      const total = countResult?.total ?? 0;

      return Response.json({
        data: products.results ?? [],
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ดึงข้อมูลสินค้าไม่สำเร็จ' }, { status: 500 });
    }
  }

  // GET /products/:id — fetch single product
  if (url.pathname.match(/^\/products\/\d+$/) && method === 'GET') {
    try {
      const id = parseInt(url.pathname.split('/')[2]);

      const product = await env.DB.prepare(
        'SELECT * FROM products WHERE id = ?'
      )
        .bind(id)
        .first<Product>();

      if (!product) {
        return Response.json({ error: 'ไม่พบสินค้า' }, { status: 404 });
      }

      return Response.json(product);
    } catch (error: any) {
      return Response.json({ error: error.message || 'ดึงข้อมูลสินค้าไม่สำเร็จ' }, { status: 500 });
    }
  }

  return null;
}
