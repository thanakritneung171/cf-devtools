interface Env {
  VECTORIZE: VectorizeIndex;
}

export async function handleVectorizeRoutes(
  request: Request,
  env: Env,
  url: URL,
  method: string
): Promise<Response | null> {

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

  return null;
}
