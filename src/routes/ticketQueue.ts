export async function handleTicketQueueRoutes(
  request: Request,
  env: any,
  url: URL,
  method: string
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/ticket-queue")) return null;

  // POST /api/ticket-queue/booking — สร้าง booking + หัก stock + เข้าคิว (ทั้งหมดผ่าน DO) ----------------------------------------------
  if (url.pathname === "/api/ticket-queue/booking" && method === "POST") {
    try {
      const body: any = await request.json();
      const productId = body.product_id;

      if (!productId) {
        return Response.json({ error: "กรุณาระบุ productId" }, { status: 400 });
      }

      const id = env.PRODUCT_QUEUE.idFromName(productId.toString());
      const stub = env.PRODUCT_QUEUE.get(id);

      return stub.fetch("https://ticket-queue/create-booking", {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // POST /api/ticket-queue/join
  if (url.pathname === "/api/ticket-queue/join" && method === "POST") {
    try {
      const body: any = await request.json();
      const productId = body.product_id;

      if (!productId) {
        return Response.json({ error: "กรุณาระบุ product_id" }, { status: 400 });
      }

      const id = env.PRODUCT_QUEUE.idFromName(productId.toString());
      const stub = env.PRODUCT_QUEUE.get(id);

      return stub.fetch("https://ticket-queue/join", {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // GET /api/ticket-queue/status?product_id=...&user_id=...
  if (url.pathname === "/api/ticket-queue/status" && method === "GET") {
    try {
      const productId = url.searchParams.get("product_id");
      const userId = url.searchParams.get("user_id");

      if (!productId || !userId) {
        return Response.json({ error: "Missing product_id or user_id" }, { status: 400 });
      }

      const id = env.PRODUCT_QUEUE.idFromName(productId.toString());
      const stub = env.PRODUCT_QUEUE.get(id);

      return stub.fetch(`https://ticket-queue/queue/status?product_id=${productId}&user_id=${userId}`);
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // POST /api/ticket-queue/leave
  if (url.pathname === "/api/ticket-queue/leave" && method === "POST") {
    try {
      const body: any = await request.json();
      const productId = body.product_id;

      if (!productId) {
        return Response.json({ error: "กรุณาระบุ product_id" }, { status: 400 });
      }

      const id = env.PRODUCT_QUEUE.idFromName(productId.toString());
      const stub = env.PRODUCT_QUEUE.get(id);

      return stub.fetch("https://ticket-queue/leave", {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // POST /api/ticket-queue/leave-completed
  if (url.pathname === "/api/ticket-queue/leave-completed" && method === "POST") {
    try {
      const body: any = await request.json();
      const productId = body.product_id;

      if (!productId) {
        return Response.json({ error: "กรุณาระบุ product_id" }, { status: 400 });
      }

      const id = env.PRODUCT_QUEUE.idFromName(productId.toString());
      const stub = env.PRODUCT_QUEUE.get(id);

      return stub.fetch("https://ticket-queue/leave-completed", {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // POST /api/ticket-queue/leave-cancelled
  if (url.pathname === "/api/ticket-queue/leave-cancelled" && method === "POST") {
    try {
      const body: any = await request.json();
      const productId = body.product_id;

      if (!productId) {
        return Response.json({ error: "กรุณาระบุ product_id" }, { status: 400 });
      }

      const id = env.PRODUCT_QUEUE.idFromName(productId.toString());
      const stub = env.PRODUCT_QUEUE.get(id);

      return stub.fetch("https://ticket-queue/leave-cancelled", {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // PUT /api/ticket-queue/booking/:bookingId/complete — เหมือน PUT /api/bookings/:id/complete แต่ผ่าน DO ----------------------------------------------
  const completeMatch = url.pathname.match(/^\/api\/ticket-queue\/booking\/(\d+)\/complete$/);
  if (completeMatch && method === "PUT") {
    try {
      const bookingId = parseInt(completeMatch[1]);

      // หา booking เพื่อเอา product_id สำหรับ route ไป DO ที่ถูกตัว
      const booking = await env.DB.prepare(
        "SELECT product_id FROM bookings WHERE id = ?"
      ).bind(bookingId).first();

      if (!booking) {
        return Response.json({ error: "ไม่พบการจอง" }, { status: 404 });
      }

      const id = env.PRODUCT_QUEUE.idFromName(booking.product_id.toString());
      const stub = env.PRODUCT_QUEUE.get(id);

      return stub.fetch("https://ticket-queue/complete-booking", {
        method: "POST",
        body: JSON.stringify({ booking_id: bookingId }),
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // PUT /api/ticket-queue/booking/:bookingId/cancel — เหมือน PUT /api/bookings/:id/cancel แต่ผ่าน DO
  const cancelMatch = url.pathname.match(/^\/api\/ticket-queue\/booking\/(\d+)\/cancel$/);
  if (cancelMatch && method === "PUT") {
    try {
      const bookingId = parseInt(cancelMatch[1]);

      // หา booking เพื่อเอา product_id สำหรับ route ไป DO ที่ถูกตัว
      const booking = await env.DB.prepare(
        "SELECT product_id FROM bookings WHERE id = ?"
      ).bind(bookingId).first();

      if (!booking) {
        return Response.json({ error: "ไม่พบการจอง" }, { status: 404 });
      }

      const id = env.PRODUCT_QUEUE.idFromName(booking.product_id.toString());
      const stub = env.PRODUCT_QUEUE.get(id);

      return stub.fetch("https://ticket-queue/cancel-booking", {
        method: "POST",
        body: JSON.stringify({ booking_id: bookingId }),
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // GET /api/ticket-queue/all?product_id=... — debug: ดู queue ทั้งหมดใน DO storage
  if (url.pathname === "/api/ticket-queue/all" && method === "GET") {
    try {
      const productId = url.searchParams.get("product_id");

      if (!productId) {
        return Response.json({ error: "Missing product_id" }, { status: 400 });
      }

      const id = env.PRODUCT_QUEUE.idFromName(productId.toString());
      const stub = env.PRODUCT_QUEUE.get(id);

      return stub.fetch(`https://ticket-queue/queue/all`);
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // GET /api/ticket-queue/active-count?product_id=...
  if (url.pathname === "/api/ticket-queue/active-count" && method === "GET") {
    try {
      const productId = url.searchParams.get("product_id");

      if (!productId) {
        return Response.json({ error: "Missing product_id" }, { status: 400 });
      }

      const id = env.PRODUCT_QUEUE.idFromName(productId.toString());
      const stub = env.PRODUCT_QUEUE.get(id);

      return stub.fetch(`https://ticket-queue/active-count?product_id=${productId}`);
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  return null;
}
