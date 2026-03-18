interface QueueEntry {
  id: number;
  user_id: number;
  product_id: number;
  booking_id: number | null;
  status: 'ACTIVE' | 'WAITING';
  created_at: string;
}

export class TicketQueueDOTest {
  state: DurableObjectState;
  env: any;
  ACTIVE_LIMIT = 2;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
  }

  // ===== DO Storage helpers =====

  private async getQueue(): Promise<QueueEntry[]> {
    return (await this.state.storage.get<QueueEntry[]>("queue")) || [];
  }

  private async saveQueue(queue: QueueEntry[]): Promise<void> {
    await this.state.storage.put("queue", queue);
  }

  private async getNextId(): Promise<number> {
    const current = (await this.state.storage.get<number>("nextId")) || 0;
    const next = current + 1;
    await this.state.storage.put("nextId", next);
    return next;
  }

  private getActiveCount(queue: QueueEntry[]): number {
    return queue.filter((e) => e.status === "ACTIVE").length;
  }

  /** promote คนถัดไปจาก WAITING → ACTIVE ถ้ายังไม่เต็ม + อัปเดต booking เป็น booked */
  private async promoteNext(queue: QueueEntry[]): Promise<void> {
    const activeCount = this.getActiveCount(queue);
    if (activeCount < this.ACTIVE_LIMIT) {
      const next = queue.find((e) => e.status === "WAITING");
      if (next) {
        next.status = "ACTIVE";
        // อัปเดต booking ของคนที่ถูก promote เป็น booked
        if (next.booking_id) {
          await this.env.DB.prepare(
            "UPDATE bookings SET status = 'booked' WHERE id = ?"
          ).bind(next.booking_id).run();
        }
      }
    }
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    const method = request.method;

    // POST /create-booking — สร้าง booking + หัก stock + เข้าคิว (ทำทั้งหมดใน DO single-threaded)
    if (url.pathname.endsWith("/create-booking") && method === "POST") {
      const body: any = await request.json();
      const userId = Math.floor(Number(body.user_id));
      const productId = Math.floor(Number(body.product_id));
      const quantity = Math.floor(Number(body.quantity));

      if (!userId || !productId || !quantity) {
        return Response.json({ error: "กรุณาระบุ user_id, product_id, quantity" }, { status: 400 });
      }

      // 1. เช็คสินค้า (D1)
      const product = await this.env.DB.prepare(
        "SELECT id, product_name, total_quantity, available_quantity FROM productsPOC WHERE id = ?"
      ).bind(productId).first();

      if (!product) {
        return Response.json({ error: "ไม่พบสินค้า" }, { status: 404 });
      }

      // 2. เช็ค quantity
      if (quantity > product.total_quantity) {
        return Response.json(
          { error: `ไม่สามารถจองเกินจำนวนสูงสุดได้ (total_quantity = ${product.total_quantity})` },
          { status: 400 }
        );
      }
      if (quantity > product.available_quantity) {
        return Response.json(
          { error: `สินค้าไม่เพียงพอ (available_quantity = ${product.available_quantity})` },
          { status: 400 }
        );
      }

      // 3. เช็คซ้ำ — ห้ามจองซ้ำถ้ายังอยู่ใน queue (DO Storage)
      const queue = await this.getQueue();
      const existing = queue.find(
        (e) => e.product_id === productId && e.user_id === userId
      );8

      if (existing) {
        return Response.json(
          { error: `ผู้ใช้ ${userId} มีคิวอยู่แล้วสำหรับสินค้า ${productId} ไม่สามารถจองซ้ำได้` },
          { status: 409 }
        );
      }

      // 4. นับ ACTIVE → กำหนด status
      const activeCount = this.getActiveCount(queue);
      const queueStatus: 'ACTIVE' | 'WAITING' = activeCount < this.ACTIVE_LIMIT ? "ACTIVE" : "WAITING";
      const bookingStatus = queueStatus === "ACTIVE" ? "booked" : "WAITING";

      // 5. สร้าง booking (D1)
      const bookingResult = await this.env.DB.prepare(
        "INSERT INTO bookings (user_id, product_id, quantity, status) VALUES (?, ?, ?, ?)"
      ).bind(userId, productId, quantity, bookingStatus).run();

      const bookingId = bookingResult.meta.last_row_id;

      // 6. หัก stock (D1)
      await this.env.DB.prepare(
        "UPDATE productsPOC SET available_quantity = available_quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(quantity, productId).run();

      // 7. เพิ่มเข้า queue (DO Storage)
      const queueId = await this.getNextId();
      const now = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString(); // UTC+7
      const newEntry: QueueEntry = {
        id: queueId,
        user_id: userId,
        product_id: productId,
        booking_id: bookingId,
        status: queueStatus,
        created_at: now,
      };
      queue.push(newEntry);
      await this.saveQueue(queue);

      // 8. หา position
      const position = queue.filter(
        (e) => e.product_id === productId
      ).findIndex((e) => e.id === queueId) + 1;

      // 9. ดึง booking ที่สร้าง (D1)
      const booking = await this.env.DB.prepare(
        "SELECT * FROM bookings WHERE id = ?"
      ).bind(bookingId).first();

      const message = bookingStatus === "booked"
        ? "จองสินค้าสำเร็จ (ACTIVE)"
        : "สินค้าถูกจอง แต่คิวเต็ม รอคิว (WAITING)";

      return Response.json({
        booking,
        product_queue: newEntry,
        queue_status: queueStatus,
        queue_position: position,
        message,
      }, { status: 201 });
    }

    // GET /queue/status — เช็คสถานะคิวของ user
    if (url.pathname.endsWith("/queue/status") && method === "GET") {
      const userId = url.searchParams.get("user_id");
      const productId = url.searchParams.get("product_id");

      if (!userId || !productId) {
        return Response.json({ error: "Missing user_id or product_id" }, { status: 400 });
      }

      const uid = Math.floor(Number(userId));
      const pid = Math.floor(Number(productId));
      const queue = await this.getQueue();
      const productQueue = queue.filter((e) => e.product_id === pid);
      const idx = productQueue.findIndex((e) => e.user_id === uid);

      if (idx === -1) {
        return Response.json({ error: "ไม่พบคิวของผู้ใช้นี้" }, { status: 404 });
      }

      return Response.json({
        queue_entry: productQueue[idx],
        position: idx + 1,
        total_in_queue: productQueue.length,
        active_count: productQueue.filter((e) => e.status === "ACTIVE").length,
      });
    }

    // POST /leave-completed — เสร็จแล้ว: ลบ queue entry, booking → completed, ไม่คืน stock
    if (url.pathname.endsWith("/leave-completed") && method === "POST") {
      const body: any = await request.json();
      const userId = Math.floor(Number(body.user_id));
      const productId = Math.floor(Number(body.product_id));

      if (!userId || !productId) {
        return Response.json({ error: "กรุณาระบุ user_id และ product_id" }, { status: 400 });
      }

      const queue = await this.getQueue();
      const idx = queue.findIndex(
        (e) => e.user_id === userId && e.product_id === productId && e.status === "ACTIVE"
      );

      if (idx === -1) {
        return Response.json({ error: "ไม่พบคิว ACTIVE ของผู้ใช้นี้" }, { status: 404 });
      }

      const entry = queue[idx];
      queue.splice(idx, 1);

      // อัปเดต booking → completed (D1)
      if (entry.booking_id) {
        await this.env.DB.prepare(
          "UPDATE bookings SET status = 'completed' WHERE id = ?"
        ).bind(entry.booking_id).run();
      }

      // promote คนถัดไป
      await this.promoteNext(queue);
      await this.saveQueue(queue);

      return Response.json({ message: "completed", bookingId: entry.booking_id });
    }

    // POST /leave-cancelled — ยกเลิก: ลบ queue entry, booking → cancelled, คืน stock
    if (url.pathname.endsWith("/leave-cancelled") && method === "POST") {
      const body: any = await request.json();
      const userId = Math.floor(Number(body.user_id));
      const productId = Math.floor(Number(body.product_id));

      if (!userId || !productId) {
        return Response.json({ error: "กรุณาระบุ user_id และ product_id" }, { status: 400 });
      }

      const queue = await this.getQueue();
      const idx = queue.findIndex(
        (e) => e.user_id === userId && e.product_id === productId && (e.status === "ACTIVE" || e.status === "WAITING")
      );

      if (idx === -1) {
        return Response.json({ error: "ไม่พบคิวของผู้ใช้นี้" }, { status: 404 });
      }

      const entry = queue[idx];
      queue.splice(idx, 1);

      // อัปเดต booking → cancelled + คืน stock (D1)
      if (entry.booking_id) {
        const booking = await this.env.DB.prepare(
          "SELECT quantity FROM bookings WHERE id = ?"
        ).bind(entry.booking_id).first();

        await this.env.DB.prepare(
          "UPDATE bookings SET status = 'cancelled' WHERE id = ?"
        ).bind(entry.booking_id).run();

        // คืน available_quantity
        if (booking?.quantity) {
          await this.env.DB.prepare(
            "UPDATE productsPOC SET available_quantity = available_quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
          ).bind(booking.quantity, productId).run();
        }
      }

      // promote คนถัดไป
      await this.promoteNext(queue);
      await this.saveQueue(queue);

      return Response.json({ message: "cancelled", bookingId: entry.booking_id });
    }

    // POST /complete-booking — รับ bookingId → ลบ queue entry → booking completed → promote
    if (url.pathname.endsWith("/complete-booking") && method === "POST") {
      const body: any = await request.json();
      const bookingId = Math.floor(Number(body.booking_id));

      if (!bookingId) {
        return Response.json({ error: "กรุณาระบุ booking_id" }, { status: 400 });
      }

      // ดึง booking เพื่อเช็คสถานะ (D1)
      const booking = await this.env.DB.prepare(
        "SELECT id, product_id, quantity, status FROM bookings WHERE id = ?"
      ).bind(bookingId).first();

      if (!booking) {
        return Response.json({ error: "ไม่พบการจอง" }, { status: 404 });
      }
      if (booking.status === "completed" || booking.status === "cancelled") {
        return Response.json({ error: `ไม่สามารถ complete ได้ สถานะปัจจุบัน: ${booking.status}` }, { status: 400 });
      }

      // หา queue entry จาก booking_id (DO Storage)
      const queue = await this.getQueue();
      const idx = queue.findIndex((e) => e.booking_id === bookingId);

      if (idx !== -1) {
        queue.splice(idx, 1);
      }

      // อัปเดต booking → completed (D1)
      await this.env.DB.prepare(
        "UPDATE bookings SET status = 'completed' WHERE id = ?"
      ).bind(bookingId).run();

      // promote คนถัดไป
      await this.promoteNext(queue);
      await this.saveQueue(queue);

      const updated = await this.env.DB.prepare(
        "SELECT * FROM bookings WHERE id = ?"
      ).bind(bookingId).first();

      return Response.json({
        booking: updated,
        message: "เสร็จสิ้นการจอง product_queue เปลี่ยนเป็น COMPLETED คิว WAITING ถัดไปได้ promote เป็น ACTIVE",
      });
    }

    // POST /cancel-booking — รับ bookingId → ลบ queue entry → booking cancelled → คืน stock → promote
    if (url.pathname.endsWith("/cancel-booking") && method === "POST") {
      const body: any = await request.json();
      const bookingId = Math.floor(Number(body.booking_id));

      if (!bookingId) {
        return Response.json({ error: "กรุณาระบุ booking_id" }, { status: 400 });
      }

      // ดึง booking เพื่อเช็คสถานะ + quantity (D1)
      const booking = await this.env.DB.prepare(
        "SELECT id, product_id, quantity, status FROM bookings WHERE id = ?"
      ).bind(bookingId).first();

      if (!booking) {
        return Response.json({ error: "ไม่พบการจอง" }, { status: 404 });
      }
      if (booking.status === "cancelled") {
        return Response.json({ error: "การจองถูกยกเลิกแล้ว" }, { status: 400 });
      }

      // หา queue entry จาก booking_id (DO Storage)
      const queue = await this.getQueue();
      const idx = queue.findIndex((e) => e.booking_id === bookingId);

      if (idx !== -1) {
        queue.splice(idx, 1);
      }

      // อัปเดต booking → cancelled (D1)
      await this.env.DB.prepare(
        "UPDATE bookings SET status = 'cancelled' WHERE id = ?"
      ).bind(bookingId).run();

      // คืน available_quantity (D1)
      if (booking.quantity) {
        await this.env.DB.prepare(
          "UPDATE productsPOC SET available_quantity = available_quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(booking.quantity, booking.product_id).run();
      }

      // promote คนถัดไป
      await this.promoteNext(queue);
      await this.saveQueue(queue);

      const updated = await this.env.DB.prepare(
        "SELECT * FROM bookings WHERE id = ?"
      ).bind(bookingId).first();

      return Response.json({
        booking: updated,
        message: "ยกเลิกการจองสำเร็จ คืน stock แล้ว product_queue เปลี่ยนเป็น CANCELLED คิว WAITING ถัดไปได้ promote เป็น ACTIVE",
      });
    }

    // GET /active-count — นับจำนวน active
    if (url.pathname.endsWith("/active-count") && method === "GET") {
      const productId = url.searchParams.get("product_id");

      if (!productId) {
        return Response.json({ error: "Missing product_id" }, { status: 400 });
      }

      const pid = Math.floor(Number(productId));
      const queue = await this.getQueue();
      const activeCount = queue.filter(
        (e) => e.product_id === pid && e.status === "ACTIVE"
      ).length;

      return Response.json({
        activeCount,
        limit: this.ACTIVE_LIMIT,
      });
    }

    // GET /queue/all — debug: ดู queue ทั้งหมดใน DO storage
    if (url.pathname.endsWith("/queue/all") && method === "GET") {
      const queue = await this.getQueue();
      const nextId = (await this.state.storage.get<number>("nextId")) || 0;

      return Response.json({
        queue,
        total: queue.length,
        nextId,
        active_count: queue.filter((e) => e.status === "ACTIVE").length,
        waiting_count: queue.filter((e) => e.status === "WAITING").length,
      });
    }

    return Response.json({ error: "Not Found" }, { status: 404 });
  }
}
