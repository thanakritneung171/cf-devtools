interface Env {
  MY_BUCKET: R2Bucket;
  PRODUCTS_INDEX: VectorizeIndex;
  AI: Ai;
  R2_DOMAIN: string;
}

const R2_PREFIX = 'documents';

async function generateEmbedding(ai: Ai, text: string): Promise<number[]> {
  const result = await ai.run('@cf/baai/bge-base-en-v1.5', { text: [text] }) as { data: number[][] };
  return result.data[0];
}

export async function handleDocumentRoutes(
  request: Request,
  env: Env,
  url: URL,
  method: string
): Promise<Response | null> {

  // POST /api/documents
  // รับ JSON: { key, content, title?, tags? }
  // หรือ multipart/form-data: file (text), key, title?, tags?
  // Flow: เซฟไฟล์ลง R2 → อ่าน content → generate embedding → เซฟ vector
  if (url.pathname === '/api/documents' && method === 'POST') {
    try {
      const contentType = request.headers.get('content-type') || '';
      let key: string;
      let content: string;
      let title: string;
      let tags: string;

      if (contentType.includes('multipart/form-data')) {
        // รับไฟล์ text ผ่าน form-data
        const form = await request.formData();
        const file = form.get('file') as File | null;
        if (!file) {
          return Response.json({ error: 'กรุณาแนบ file' }, { status: 400 });
        }
        if (!file.type.startsWith('text/') && file.type !== 'application/json') {
          return Response.json({ error: 'รองรับเฉพาะไฟล์ text/* หรือ application/json' }, { status: 400 });
        }
        key   = (form.get('key') as string) || `${Date.now()}-${file.name}`;
        title = (form.get('title') as string) || file.name;
        tags  = (form.get('tags') as string) || '';
        content = await file.text();
      } else {
        // JSON body
        const body = await request.json<{ key?: string; content: string; title?: string; tags?: string }>();
        if (!body.content) {
          return Response.json({ error: 'กรุณาระบุ content' }, { status: 400 });
        }
        key     = body.key || `doc-${Date.now()}`;
        content = body.content;
        title   = body.title || key;
        tags    = body.tags || '';
      }

      const r2Key = `${R2_PREFIX}/${key}`;

      // 1. เซฟ content ลง R2
      await env.MY_BUCKET.put(r2Key, content, {
        httpMetadata: { contentType: 'text/plain; charset=utf-8' },
        customMetadata: { title, tags },
      });

      // 2. Generate embedding จาก content (ตัด max 2000 ตัวอักษร เพื่อ performance)
      const embedText = content.slice(0, 2000);
      const embedding = await generateEmbedding(env.AI, embedText);

      // 3. เซฟ vector ลง Vectorize (id = r2Key)
      await env.PRODUCTS_INDEX.insert([
        {
          id: r2Key,
          values: embedding,
          metadata: {
            type: 'document',
            key,
            r2_key: r2Key,
            title,
            tags,
            r2_url: `${env.R2_DOMAIN}/${r2Key}`,
          },
        },
      ]);

      return Response.json(
        {
          message: 'บันทึกสำเร็จ',
          key,
          r2_key: r2Key,
          title,
          tags,
          content_length: content.length,
          r2_url: `${env.R2_DOMAIN}/${r2Key}`,
        },
        { status: 201 }
      );
    } catch (error: any) {
      return Response.json({ error: error.message || 'บันทึกไม่สำเร็จ' }, { status: 500 });
    }
  }

  // POST /api/documents/upload
  // รับ multipart/form-data: file (any type), title?, tags?, key?
  // Flow: เซฟไฟล์ดิบลง R2 → ถ้าเป็น text ใช้ content สร้าง embedding / ถ้าไม่ใช่ใช้ชื่อไฟล์+title
  if (url.pathname === '/api/documents/upload' && method === 'POST') {
    try {
      const form = await request.formData();
      const file = form.get('file') as File | null;

      if (!file || file.size === 0) {
        return Response.json({ error: 'กรุณาแนบ file' }, { status: 400 });
      }

      if (file.size > 10 * 1024 * 1024) {
        return Response.json({ error: 'ขนาดไฟล์ต้องน้อยกว่า 10MB' }, { status: 400 });
      }

      const key   = (form.get('key') as string) || `${Date.now()}-${file.name}`;
      const title = (form.get('title') as string) || file.name;
      const tags  = (form.get('tags') as string) || '';
      const r2Key = `${R2_PREFIX}/${key}`;

      // 1. เซฟไฟล์ดิบลง R2 (เก็บ content-type ของจริง)
      const buffer = await file.arrayBuffer();
      await env.MY_BUCKET.put(r2Key, buffer, {
        httpMetadata: { contentType: file.type || 'application/octet-stream' },
        customMetadata: { title, tags, original_name: file.name },
      });

      // 2. เตรียม text สำหรับ embedding
      //    - text file → ใช้ content (max 2000 chars)
      //    - ไฟล์อื่น → ใช้ title + filename + tags แทน
      let embedText: string;
      if (file.type.startsWith('text/') || file.type === 'application/json') {
        const decoder = new TextDecoder('utf-8');
        embedText = decoder.decode(buffer).slice(0, 2000);
      } else {
        embedText = `${title} ${file.name} ${tags}`.trim();
      }

      // 3. Generate embedding
      const embedding = await generateEmbedding(env.AI, embedText);

      // 4. เซฟ vector ลง Vectorize
      await env.PRODUCTS_INDEX.insert([
        {
          id: r2Key,
          values: embedding,
          metadata: {
            type: 'document',
            key,
            r2_key: r2Key,
            title,
            tags,
            file_type: file.type || 'application/octet-stream',
            original_name: file.name,
            r2_url: `${env.R2_DOMAIN}/${r2Key}`,
          },
        },
      ]);

      return Response.json(
        {
          message: 'อัพโหลดสำเร็จ',
          key,
          r2_key: r2Key,
          title,
          tags,
          original_name: file.name,
          file_type: file.type,
          size: file.size,
          r2_url: `${env.R2_DOMAIN}/${r2Key}`,
        },
        { status: 201 }
      );
    } catch (error: any) {
      return Response.json({ error: error.message || 'อัพโหลดไม่สำเร็จ' }, { status: 500 });
    }
  }

  // GET /api/documents/search?q=...
  // Semantic search: AI แปลง query → vector → ค้นใน Vectorize → คืน metadata + R2 URL
  if (url.pathname === '/api/documents/search' && method === 'GET') {
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
        filter: { type: 'document' },
      });

      const results = (matches.matches ?? []).map((m) => ({
        id: m.id,
        score: m.score,
        ...((m.metadata as Record<string, string>) ?? {}),
      }));

      return Response.json({ query: q, results });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ค้นหาไม่สำเร็จ' }, { status: 500 });
    }
  }

  // GET /api/documents/:key — อ่าน content ของ document จาก R2
  if (url.pathname.startsWith('/api/documents/') && method === 'GET') {
    try {
      const key = url.pathname.replace('/api/documents/', '');
      if (!key) {
        return Response.json({ error: 'กรุณาระบุ key' }, { status: 400 });
      }

      const r2Key = `${R2_PREFIX}/${key}`;
      const object = await env.MY_BUCKET.get(r2Key);

      if (!object) {
        return Response.json({ error: 'ไม่พบ document' }, { status: 404 });
      }

      const content = await object.text();
      const meta = object.customMetadata ?? {};

      return Response.json({
        key,
        r2_key: r2Key,
        title: meta.title || key,
        tags: meta.tags || '',
        content,
        size: object.size,
        uploaded: object.uploaded,
      });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ดึงข้อมูลไม่สำเร็จ' }, { status: 500 });
    }
  }

  // DELETE /api/documents/:key — ลบจาก R2 และ Vectorize พร้อมกัน
  if (url.pathname.startsWith('/api/documents/') && method === 'DELETE') {
    try {
      const key = url.pathname.replace('/api/documents/', '');
      if (!key) {
        return Response.json({ error: 'กรุณาระบุ key' }, { status: 400 });
      }

      const r2Key = `${R2_PREFIX}/${key}`;

      // ลบทั้ง R2 และ Vectorize พร้อมกัน
      await Promise.all([
        env.MY_BUCKET.delete(r2Key),
        env.PRODUCTS_INDEX.deleteByIds([r2Key]),
      ]);

      return Response.json({ message: 'ลบสำเร็จ', key, r2_key: r2Key });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ลบไม่สำเร็จ' }, { status: 500 });
    }
  }

  return null;
}
