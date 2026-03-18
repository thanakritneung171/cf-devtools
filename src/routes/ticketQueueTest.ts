export async function handleTicketQueueTestRoutes(
  request: Request,
  env: any,
  url: URL,
  method: string
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/ticket-queue-test")) return null;

  // POST /api/ticket-queue-test/booking — สร้าง booking + หัก stock + เข้าคิว (ผ่าน DO Storage)
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

  // GET /api/ticket-queue-test/status?product_id=...&user_id=...
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

  // POST /api/ticket-queue-test/leave-completed
  if (url.pathname === "/api/ticket-queue-test/leave-completed" && method === "POST") {
    try {
      const body: any = await request.json();
      const productId = body.product_id;

      if (!productId) {
        return Response.json({ error: "กรุณาระบุ product_id" }, { status: 400 });
      }

      const id = env.TICKET_QUEUE_TEST.idFromName(productId.toString());
      const stub = env.TICKET_QUEUE_TEST.get(id);

      return stub.fetch("https://ticket-queue-test/leave-completed", {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // POST /api/ticket-queue-test/leave-cancelled
  if (url.pathname === "/api/ticket-queue-test/leave-cancelled" && method === "POST") {
    try {
      const body: any = await request.json();
      const productId = body.product_id;

      if (!productId) {
        return Response.json({ error: "กรุณาระบุ product_id" }, { status: 400 });
      }

      const id = env.TICKET_QUEUE_TEST.idFromName(productId.toString());
      const stub = env.TICKET_QUEUE_TEST.get(id);

      return stub.fetch("https://ticket-queue-test/leave-cancelled", {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // PUT /api/ticket-queue-test/booking/:bookingId/complete
  const completeMatch = url.pathname.match(/^\/api\/ticket-queue-test\/booking\/(\d+)\/complete$/);
  if (completeMatch && method === "PUT") {
    try {
      const bookingId = parseInt(completeMatch[1]);

      const booking = await env.DB.prepare(
        "SELECT product_id FROM bookings WHERE id = ?"
      ).bind(bookingId).first();

      if (!booking) {
        return Response.json({ error: "ไม่พบการจอง" }, { status: 404 });
      }

      const id = env.TICKET_QUEUE_TEST.idFromName(booking.product_id.toString());
      const stub = env.TICKET_QUEUE_TEST.get(id);

      return stub.fetch("https://ticket-queue-test/complete-booking", {
        method: "POST",
        body: JSON.stringify({ booking_id: bookingId }),
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // PUT /api/ticket-queue-test/booking/:bookingId/cancel
  const cancelMatch = url.pathname.match(/^\/api\/ticket-queue-test\/booking\/(\d+)\/cancel$/);
  if (cancelMatch && method === "PUT") {
    try {
      const bookingId = parseInt(cancelMatch[1]);

      const booking = await env.DB.prepare(
        "SELECT product_id FROM bookings WHERE id = ?"
      ).bind(bookingId).first();

      if (!booking) {
        return Response.json({ error: "ไม่พบการจอง" }, { status: 404 });
      }

      const id = env.TICKET_QUEUE_TEST.idFromName(booking.product_id.toString());
      const stub = env.TICKET_QUEUE_TEST.get(id);

      return stub.fetch("https://ticket-queue-test/cancel-booking", {
        method: "POST",
        body: JSON.stringify({ booking_id: bookingId }),
      });
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // GET /api/ticket-queue-test/active-count?product_id=...
  if (url.pathname === "/api/ticket-queue-test/active-count" && method === "GET") {
    try {
      const productId = url.searchParams.get("product_id");

      if (!productId) {
        return Response.json({ error: "Missing product_id" }, { status: 400 });
      }

      const id = env.TICKET_QUEUE_TEST.idFromName(productId.toString());
      const stub = env.TICKET_QUEUE_TEST.get(id);

      return stub.fetch(`https://ticket-queue-test/active-count?product_id=${productId}`);
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // GET /api/ticket-queue-test/all?product_id=... — debug: ดู queue ทั้งหมดใน DO storage
  if (url.pathname === "/api/ticket-queue-test/all" && method === "GET") {
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

  return null;
}
