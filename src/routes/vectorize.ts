interface Env {
  VECTORIZE: VectorizeIndex;
  PRODUCTS_POC_INDEX: VectorizeIndex;
  BOOKINGS_INDEX: VectorizeIndex;
  DB: D1Database;
  MY_BUCKET: R2Bucket;
}

const GET_BY_IDS_BATCH_SIZE = 20; // Vectorize getByIds limit is 20
const UPSERT_BATCH_SIZE = 100;

async function fetchVectorsInBatches(index: VectorizeIndex, ids: string[]): Promise<VectorizeVector[]> {
  const all: VectorizeVector[] = [];
  for (let i = 0; i < ids.length; i += GET_BY_IDS_BATCH_SIZE) {
    const batch = ids.slice(i, i + GET_BY_IDS_BATCH_SIZE);
    const vectors = await index.getByIds(batch);
    all.push(...vectors);
  }
  return all;
}

async function upsertVectorsInBatches(index: VectorizeIndex, vectors: VectorizeVector[]): Promise<void> {
  for (let i = 0; i < vectors.length; i += UPSERT_BATCH_SIZE) {
    await index.upsert(vectors.slice(i, i + UPSERT_BATCH_SIZE));
  }
}

export async function handleVectorizeRoutes(
  request: Request,
  env: Env,
  url: URL,
  method: string
): Promise<Response | null> {

  console.log(`Received request: ${method} ${url.pathname}`);
  // POST /api/vectorize/insert
  // Body: { vectors: [{ id: string, values: number[], metadata?: Record<string, string> }] }
  if (url.pathname === '/api/vectorize/insert' && method === 'POST') {
    try {
      const body = await request.json<{ vectors: VectorizeVector[] }>();

      if (!body.vectors || !Array.isArray(body.vectors) || body.vectors.length === 0) {
        return Response.json({ error: 'กรุณาระบุ vectors อย่างน้อย 1 รายการ' }, { status: 400 });
      }

      const result = await env.VECTORIZE.insert(body.vectors);
      return Response.json({ message: 'Insert สำเร็จ', result }, { status: 201 });
    } catch (error: any) {
      return Response.json({ error: error.message || 'Insert ไม่สำเร็จ' }, { status: 500 });
    }
  }

  // POST /api/vectorize/query
  // Body: { vector: number[], topK?: number, returnValues?: boolean, returnMetadata?: VectorizeMetadataRetrievalLevel }
  if (url.pathname === '/api/vectorize/query' && method === 'POST') {
    try {
      const body = await request.json<{
        vector: number[];
        topK?: number;
        returnValues?: boolean;
        returnMetadata?: VectorizeMetadataRetrievalLevel;
      }>();

      if (!body.vector || !Array.isArray(body.vector)) {
        return Response.json({ error: 'กรุณาระบุ vector สำหรับค้นหา' }, { status: 400 });
      }

      const matches = await env.VECTORIZE.query(body.vector, {
        topK: body.topK ?? 3,
        returnValues: body.returnValues ?? false,
        returnMetadata: body.returnMetadata ?? 'all',
      });

      return Response.json({ matches });
    } catch (error: any) {
      return Response.json({ error: error.message || 'Query ไม่สำเร็จ' }, { status: 500 });
    }
  }

  // GET /api/vectorize/backups — แสดงรายการ backup files ใน R2
  if (url.pathname === '/api/vectorize/backups' && method === 'GET') {
    try {
      const prefix = url.searchParams.get('prefix') || 'vectorize-backup/';
      const listed = await env.MY_BUCKET.list({ prefix });
      const files = (listed.objects || []).map((obj) => ({
        key: obj.key,
        size: obj.size,
        uploaded: obj.uploaded,
      }));
      return Response.json({ backups: files, count: files.length });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ดึงรายการ backup ไม่สำเร็จ' }, { status: 500 });
    }
  }

  // GET /api/vectorize/:id — ดึง vector ตาม ID
  if (url.pathname.startsWith('/api/vectorize/') && method === 'GET') {
    try {
      const id = url.pathname.split('/')[3];
      if (!id) {
        return Response.json({ error: 'กรุณาระบุ ID' }, { status: 400 });
      }

      const vectors = await env.VECTORIZE.getByIds([id]);
      if (!vectors || vectors.length === 0) {
        return Response.json({ error: 'ไม่พบ vector' }, { status: 404 });
      }

      return Response.json({ vector: vectors[0] });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ดึงข้อมูลไม่สำเร็จ' }, { status: 500 });
    }
  }

  // DELETE /api/vectorize/delete
  // Body: { ids: string[] }
  if (url.pathname === '/api/vectorize/delete' && method === 'DELETE') {
    try {
      const body = await request.json<{ ids: string[] }>();

      if (!body.ids || !Array.isArray(body.ids) || body.ids.length === 0) {
        return Response.json({ error: 'กรุณาระบุ ids ที่ต้องการลบ' }, { status: 400 });
      }

      const result = await env.VECTORIZE.deleteByIds(body.ids);
      return Response.json({ message: 'ลบสำเร็จ', result });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ลบไม่สำเร็จ' }, { status: 500 });
    }
  }

  // POST /api/vectorize/backup — backup vectors จาก Vectorize index ลง R2
  // Body: { index: "products_poc" | "bookings" | "all" }
  if (url.pathname === '/api/vectorize/backup' && method === 'POST') {
    try {
      const body = await request.json<{ index?: string }>();
      const indexName = body.index || 'all';

      if (!['products_poc', 'bookings', 'all'].includes(indexName)) {
        return Response.json({ error: 'index ต้องเป็น products_poc, bookings, หรือ all' }, { status: 400 });
      }

      const results: { index: string; key: string; count: number }[] = [];

      if (indexName === 'products_poc' || indexName === 'all') {
        const rows = await env.DB.prepare('SELECT id FROM productsPOC').all<{ id: number }>();
        const ids = (rows.results || []).map((r) => String(r.id));
        const vectors = await fetchVectorsInBatches(env.PRODUCTS_POC_INDEX, ids);
        const backedUpAt = new Date().toISOString();
        const key = `vectorize-backup/products_poc/${backedUpAt}.json`;
        await env.MY_BUCKET.put(
          key,
          JSON.stringify({ index: 'PRODUCTS_POC_INDEX', backed_up_at: backedUpAt, count: vectors.length, vectors }),
          { httpMetadata: { contentType: 'application/json' } }
        );
        results.push({ index: 'products_poc', key, count: vectors.length });
      }

      if (indexName === 'bookings' || indexName === 'all') {
        const rows = await env.DB.prepare('SELECT id FROM bookings').all<{ id: number }>();
        const ids = (rows.results || []).map((r) => String(r.id));
        const vectors = await fetchVectorsInBatches(env.BOOKINGS_INDEX, ids);
        const backedUpAt = new Date().toISOString();
        const key = `vectorize-backup/bookings/${backedUpAt}.json`;
        await env.MY_BUCKET.put(
          key,
          JSON.stringify({ index: 'BOOKINGS_INDEX', backed_up_at: backedUpAt, count: vectors.length, vectors }),
          { httpMetadata: { contentType: 'application/json' } }
        );
        results.push({ index: 'bookings', key, count: vectors.length });
      }

      return Response.json({ message: 'Backup สำเร็จ', results });
    } catch (error: any) {
      return Response.json({ error: error.message || 'Backup ไม่สำเร็จ' }, { status: 500 });
    }
  }

  // POST /api/vectorize/restore — restore vectors จาก backup ใน R2 กลับเข้า Vectorize
  // Body: { key: "vectorize-backup/products_poc/2026-03-17T..." }
  if (url.pathname === '/api/vectorize/restore' && method === 'POST') {
    try {
      const body = await request.json<{ key: string }>();
      if (!body.key) {
        return Response.json({ error: 'กรุณาระบุ key ของไฟล์ backup ใน R2' }, { status: 400 });
      }

      const object = await env.MY_BUCKET.get(body.key);
      if (!object) {
        return Response.json({ error: 'ไม่พบไฟล์ backup' }, { status: 404 });
      }

      const data = await object.json<{ index: string; vectors: VectorizeVector[] }>();
      if (!data.vectors || data.vectors.length === 0) {
        return Response.json({ message: 'ไม่มี vectors ใน backup นี้', restored: 0 });
      }

      const indexMap: Record<string, VectorizeIndex> = {
        PRODUCTS_POC_INDEX: env.PRODUCTS_POC_INDEX,
        BOOKINGS_INDEX: env.BOOKINGS_INDEX,
      };

      const targetIndex = indexMap[data.index];
      if (!targetIndex) {
        return Response.json({ error: `ไม่รู้จัก index: ${data.index}` }, { status: 400 });
      }

      await upsertVectorsInBatches(targetIndex, data.vectors);

      return Response.json({ message: 'Restore สำเร็จ', index: data.index, restored: data.vectors.length });
    } catch (error: any) {
      return Response.json({ error: error.message || 'Restore ไม่สำเร็จ' }, { status: 500 });
    }
  }

  return null;
}
