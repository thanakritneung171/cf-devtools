export async function handleTicketQueueTestRoutes(
  request: Request,
  env: any,
  url: URL,
  method: string
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/ticket-queue-test")) return null;

  // POST /api/ticket-queue-test/booking — เข้าคิว (เก็บใน DO เท่านั้น ยังไม่สร้าง booking ใน D1)
  if (url.pathname === "/api/ticket-queue-test/booking" && method === "POST") {
    try {
      const body: any = await request.json();
      const productId = body.product_id;

      if (!productId) {
        return Response.json({ error: "กรุณาระบุ product_id" }, { status: 400 });
      }

      const id = env.TICKET_QUEUE_TEST.idFromName(productId.toString());
      const stub = env.TICKET_QUEUE_TEST.get(id);

      return stub.fetch("https://ticket-queue-test/create-booking", {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // PUT /api/ticket-queue-test/booking/:queueId/complete — complete: สร้าง booking ใน D1 + อัปเดต stock
  const completeMatch = url.pathname.match(/^\/api\/ticket-queue-test\/booking\/(\d+)\/complete$/);
  if (completeMatch && method === "PUT") {
    try {
      const queueId = parseInt(completeMatch[1]);
      const productId = url.searchParams.get("product_id");

      if (!productId) {
        return Response.json({ error: "กรุณาระบุ product_id เป็น query parameter" }, { status: 400 });
      }

      const id = env.TICKET_QUEUE_TEST.idFromName(productId.toString());
      const stub = env.TICKET_QUEUE_TEST.get(id);

      return stub.fetch("https://ticket-queue-test/complete-booking", {
        method: "POST",
        body: JSON.stringify({ queue_id: queueId }),
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // PUT /api/ticket-queue-test/booking/:queueId/cancel — cancel: คืน stock ใน DO + promote waiting
  const cancelMatch = url.pathname.match(/^\/api\/ticket-queue-test\/booking\/(\d+)\/cancel$/);
  if (cancelMatch && method === "PUT") {
    try {
      const queueId = parseInt(cancelMatch[1]);
      const productId = url.searchParams.get("product_id");

      if (!productId) {
        return Response.json({ error: "กรุณาระบุ product_id เป็น query parameter" }, { status: 400 });
      }

      const id = env.TICKET_QUEUE_TEST.idFromName(productId.toString());
      const stub = env.TICKET_QUEUE_TEST.get(id);

      return stub.fetch("https://ticket-queue-test/cancel-booking", {
        method: "POST",
        body: JSON.stringify({ queue_id: queueId }),
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // GET /api/ticket-queue-test/status?product_id=...&user_id=... — เช็คสถานะคิวของ user
  if (url.pathname === "/api/ticket-queue-test/status" && method === "GET") {
    try {
      const productId = url.searchParams.get("product_id");
      const userId = url.searchParams.get("user_id");

      if (!productId || !userId) {
        return Response.json({ error: "Missing product_id or user_id" }, { status: 400 });
      }

      const id = env.TICKET_QUEUE_TEST.idFromName(productId.toString());
      const stub = env.TICKET_QUEUE_TEST.get(id);

      return stub.fetch(`https://ticket-queue-test/queue/status?product_id=${productId}&user_id=${userId}`);
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // GET /api/ticket-queue-test/queue/user?user_id=... — ดู queue ของ user ข้ามทุก product
  if (url.pathname === "/api/ticket-queue-test/queue/user" && method === "GET") {
    try {
      const userId = url.searchParams.get("user_id");

      if (!userId) {
        return Response.json({ error: "Missing user_id" }, { status: 400 });
      }

      const uid = parseInt(userId);

      // ดึง product ทั้งหมดจาก D1
      const products = await env.DB.prepare(
        "SELECT id FROM productsPOC"
      ).all();

      const productIds: number[] = (products.results || []).map((p: any) => p.id);

      // วนเรียก DO แต่ละ product แล้ว filter เฉพาะ user นี้
      const results = await Promise.all(
        productIds.map(async (pid: number) => {
          try {
            const id = env.TICKET_QUEUE_TEST.idFromName(pid.toString());
            const stub = env.TICKET_QUEUE_TEST.get(id);
            const res = await stub.fetch(`https://ticket-queue-test/queue/all`);
            const data = await res.json() as any;

            const fullQueue: any[] = data.queue || [];
            const userEntries = fullQueue.filter((e: any) => e.user_id === uid);
            if (userEntries.length === 0) return null;

            const enrichedEntries = userEntries.map((entry: any) => {
              const idx = fullQueue.findIndex((e: any) => e.id === entry.id);
              const before = idx >= 0 ? fullQueue.slice(0, idx) : [];
              return {
                ...entry,
                total_in_queue: fullQueue.length,
                waiting_ahead: before.filter((e: any) => e.status === 'waiting').length,
                booked_ahead: before.filter((e: any) => e.status === 'booked').length,
              };
            });

            return {
              product_id: pid,
              stock: data.stock,
              effective_available: data.effective_available,
              queue_entries: enrichedEntries,
            };
          } catch {
            return null;
          }
        })
      );

      const queues = results.filter((r) => r !== null);

      // ดึงข้อมูล user จาก D1
      const user = await env.DB.prepare(
        "SELECT id, first_name, last_name, email FROM users WHERE id = ?"
      ).bind(uid).first();

      return Response.json({
        user: user || null,
        total_products: queues.length,
        data: queues,
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // GET /api/ticket-queue-test/queue-all — ดู queue ทุก product (วนเรียก DO แต่ละตัว)
  if (url.pathname === "/api/ticket-queue-test/queue-all" && method === "GET") {
    try {
      // ดึง product ทั้งหมดจาก D1
      const products = await env.DB.prepare(
        "SELECT id FROM productsPOC"
      ).all();

      const productIds: number[] = (products.results || []).map((p: any) => p.id);

      // วนเรียก DO แต่ละ product พร้อมกัน
      const results = await Promise.all(
        productIds.map(async (pid: number) => {
          try {
            const id = env.TICKET_QUEUE_TEST.idFromName(pid.toString());
            const stub = env.TICKET_QUEUE_TEST.get(id);
            const res = await stub.fetch(`https://ticket-queue-test/queue/all`);
            const data = await res.json() as any;
            // เอาเฉพาะ product ที่มีคิว
            if (data.total > 0) {
              const enrichedQueue = (data.queue || []).map((entry: any, idx: number) => {
                const before = (data.queue || []).slice(0, idx);
                return {
                  ...entry,
                  total_in_queue: data.total,
                  waiting_ahead: before.filter((e: any) => e.status === 'waiting').length,
                  booked_ahead: before.filter((e: any) => e.status === 'booked').length,
                };
              });
              return { product_id: pid, ...data, queue: enrichedQueue };
            }
            return null;
          } catch {
            return null;
          }
        })
      );

      const queues = results.filter((r) => r !== null);

      return Response.json({
        products_with_queue: queues.length,
        data: queues,
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // GET /api/ticket-queue-test/queue?product_id=... — ดู queue ของ product เดียว (JOIN user data)
  if (url.pathname === "/api/ticket-queue-test/queue" && method === "GET") {
    try {
      const productId = url.searchParams.get("product_id");

      if (!productId) {
        return Response.json({ error: "Missing product_id" }, { status: 400 });
      }

      const id = env.TICKET_QUEUE_TEST.idFromName(productId.toString());
      const stub = env.TICKET_QUEUE_TEST.get(id);

      return stub.fetch(`https://ticket-queue-test/queue/all`);
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // GET /api/ticket-queue-test/stock?product_id=... — ดู stock ปัจจุบันใน DO
  if (url.pathname === "/api/ticket-queue-test/stock" && method === "GET") {
    try {
      const productId = url.searchParams.get("product_id");

      if (!productId) {
        return Response.json({ error: "Missing product_id" }, { status: 400 });
      }

      const id = env.TICKET_QUEUE_TEST.idFromName(productId.toString());
      const stub = env.TICKET_QUEUE_TEST.get(id);

      return stub.fetch(`https://ticket-queue-test/queue/stock`);
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  return null;
}
