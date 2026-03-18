export class TicketQueueDO {
  state: DurableObjectState;
  env: any;
  ACTIVE_LIMIT = 2;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    const method = request.method;

    // POST /create-booking — สร้าง booking + หัก stock + เข้าคิว (ทำทั้งหมดใน DO single-threaded)
    // เหมือน BookingService.createBooking() แต่ผ่าน DO กัน race condition
    if (url.pathname.endsWith("/create-booking") && method === "POST") {
      const body: any = await request.json();
      const userId = Math.floor(Number(body.user_id));
      const productId = Math.floor(Number(body.product_id));
      const quantity = Math.floor(Number(body.quantity));

      if (!userId || !productId || !quantity) {
        return Response.json({ error: "กรุณาระบุ user_id, product_id, quantity" }, { status: 400 });
      }

      // 1. เช็คสินค้า
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

      // 3. เช็คซ้ำ — ห้ามจองซ้ำถ้ายังอยู่ใน queue
      const existingQueue = await this.env.DB.prepare(`
        SELECT id FROM product_queue
        WHERE product_id = ? AND user_id = ? AND status IN ('ACTIVE', 'WAITING')
        LIMIT 1
      `).bind(productId, userId).first();

      if (existingQueue) {
        return Response.json(
          { error: `ผู้ใช้ ${userId} มีคิวอยู่แล้วสำหรับสินค้า ${productId} ไม่สามารถจองซ้ำได้` },
          { status: 409 }
        );
      }

      // 4. นับ ACTIVE → กำหนด status
      const active = await this.env.DB.prepare(`
        SELECT COUNT(*) as count FROM product_queue WHERE product_id = ? AND status = 'ACTIVE'
      `).bind(productId).first();

      const queueStatus = (active?.count ?? 0) < this.ACTIVE_LIMIT ? "ACTIVE" : "WAITING";
      const bookingStatus = queueStatus === "ACTIVE" ? "booked" : "WAITING";

      // 5. สร้าง booking
      const bookingResult = await this.env.DB.prepare(
        "INSERT INTO bookings (user_id, product_id, quantity, status) VALUES (?, ?, ?, ?)"
      ).bind(userId, productId, quantity, bookingStatus).run();

      const bookingId = bookingResult.meta.last_row_id;

      // 6. หัก stock
      await this.env.DB.prepare(
        "UPDATE productsPOC SET available_quantity = available_quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(quantity, productId).run();

      // 7. เพิ่มเข้า product_queue พร้อม booking_id
      const queueInsertResult = await this.env.DB.prepare(`
        INSERT INTO product_queue (product_id, user_id, booking_id, status, created_at)
        VALUES (?, ?, ?, ?, datetime('now', '+7 hours'))
      `).bind(productId, userId, bookingId, queueStatus).run();

      const queueId = queueInsertResult.meta.last_row_id;

      // ตรวจว่า INSERT สำเร็จจริง
      if (!queueInsertResult.success || queueInsertResult.meta.changes === 0) {
        return Response.json({
          error: "INSERT product_queue ล้มเหลว",
          debug: { bookingId, productId, userId, queueStatus, meta: queueInsertResult.meta },
        }, { status: 500 });
      }

      // 8. หา position (ใช้ queueId จาก INSERT ตรงๆ)
      const position = await this.env.DB.prepare(`
        SELECT COUNT(*) as pos FROM product_queue
        WHERE product_id = ? AND status IN ('ACTIVE', 'WAITING') AND id <= ?
      `).bind(productId, queueId).first();

      // 9. ดึง booking + queue entry ที่สร้าง
      const booking = await this.env.DB.prepare(
        "SELECT * FROM bookings WHERE id = ?"
      ).bind(bookingId).first();

      const queueEntry = await this.env.DB.prepare(
        "SELECT * FROM product_queue WHERE id = ?"
      ).bind(queueId).first();

      const message = bookingStatus === "booked"
        ? "จองสินค้าสำเร็จ (ACTIVE)"
        : "สินค้าถูกจอง แต่คิวเต็ม รอคิว (WAITING)";

      return Response.json({
        booking,
        product_queue: queueEntry,
        queue_status: queueStatus,
        queue_position: position.pos,
        message,
      }, { status: 201 });
    }

    // POST /join — เข้าคิว (เช็คซ้ำ + รับ booking_id)
    if (url.pathname.endsWith("/join") && method === "POST") {
      const body: any = await request.json();
      const userId = Math.floor(Number(body.user_id));
      const productId = Math.floor(Number(body.product_id));
      const bookingId = body.booking_id ? Math.floor(Number(body.booking_id)) : null;

      if (!userId || !productId) {
        return Response.json({ error: "กรุณาระบุ user_id และ product_id" }, { status: 400 });
      }

      // เช็คซ้ำ — ห้ามจองซ้ำถ้ายังอยู่ใน queue (ACTIVE หรือ WAITING)
      const existing = await this.env.DB.prepare(`
        SELECT id FROM product_queue
        WHERE product_id = ? AND user_id = ? AND status IN ('ACTIVE', 'WAITING')
        LIMIT 1
      `).bind(productId, userId).first();

      if (existing) {
        return Response.json(
          { error: "คุณอยู่ในคิวอยู่แล้ว", existingQueueId: existing.id },
          { status: 409 }
        );
      }

      // นับ active
      const active = await this.env.DB.prepare(`
        SELECT COUNT(*) as count FROM product_queue WHERE product_id = ? AND status = 'ACTIVE'
      `).bind(productId).first();

      let status = "WAITING";
      if ((active?.count ?? 0) < this.ACTIVE_LIMIT) {
        status = "ACTIVE";
      }

      // INSERT
      await this.env.DB.prepare(`
        INSERT INTO product_queue (product_id, user_id, booking_id, status, created_at)
        VALUES (?, ?, ?, ?, datetime('now', '+7 hours'))
      `).bind(productId, userId, bookingId, status).run();

      // ดึง row ที่เพิ่งสร้าง
      const current = await this.env.DB.prepare(`
        SELECT id FROM product_queue
        WHERE product_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1
      `).bind(productId, userId).first();

      // หา position (นับจาก ACTIVE + WAITING ที่ id <= ตัวเอง)
      const position = await this.env.DB.prepare(`
        SELECT COUNT(*) as pos FROM product_queue
        WHERE product_id = ? AND status IN ('ACTIVE', 'WAITING') AND id <= ?
      `).bind(productId, current.id).first();

      return Response.json({
        queueId: current.id,
        status,
        position: position.pos,
        bookingId,
      });
    }

    // GET /queue/status — เช็คสถานะคิว
    if (url.pathname.endsWith("/queue/status") && method === "GET") {
      const productId = url.searchParams.get("product_id");
      const userId = url.searchParams.get("user_id");

      if (!productId || !userId) {
        return Response.json({ error: "Missing product_id or user_id" }, { status: 400 });
      }

      const allQueueResult = await this.env.DB.prepare(`
        SELECT id, user_id, status
        FROM product_queue
        WHERE product_id = ? AND status IN ('ACTIVE', 'WAITING')
        ORDER BY created_at
      `).bind(Math.floor(Number(productId))).all();

      const queue = allQueueResult.results;
      const index = queue.findIndex((q: any) => q.user_id === Math.floor(Number(userId)));

      let position = null;
      let peopleAhead = null;
      const total = queue.length;

      if (index !== -1) {
        position = index + 1;
        peopleAhead = index;
      }

      return Response.json({
        inQueue: index !== -1,
        position,
        peopleAhead,
        total,
      });
    }

    // POST /leave — ออกจากคิว (DELETE)
    if (url.pathname.endsWith("/leave") && method === "POST") {
      const body: any = await request.json();
      const userId = Math.floor(Number(body.user_id));
      const productId = Math.floor(Number(body.product_id));

      if (!userId || !productId) {
        return Response.json({ error: "กรุณาระบุ user_id และ product_id" }, { status: 400 });
      }

      // ลบ row แรก (เรียงตาม created_at)
      await this.env.DB.prepare(`
        DELETE FROM product_queue
        WHERE id = (
          SELECT id FROM product_queue
          WHERE user_id = ? AND product_id = ? AND status IN ('ACTIVE', 'WAITING')
          ORDER BY created_at LIMIT 1
        )
      `).bind(userId, productId).run();

      // promote คนถัดไปถ้า active ไม่เต็ม
      await this.promoteNext(productId);

      return Response.json({ message: "left queue" });
    }

    // POST /leave-completed — เสร็จแล้ว: queue → COMPLETED, booking → completed, ไม่คืน stock
    if (url.pathname.endsWith("/leave-completed") && method === "POST") {
      const body: any = await request.json();
      const userId = Math.floor(Number(body.user_id));
      const productId = Math.floor(Number(body.product_id));

      if (!userId || !productId) {
        return Response.json({ error: "กรุณาระบุ user_id และ product_id" }, { status: 400 });
      }

      // ดึง queue row ก่อน (เพื่อเอา booking_id)
      const queueRow = await this.env.DB.prepare(`
        SELECT id, booking_id FROM product_queue
        WHERE user_id = ? AND product_id = ? AND status = 'ACTIVE'
        ORDER BY created_at LIMIT 1
      `).bind(userId, productId).first();

      if (!queueRow) {
        return Response.json({ error: "ไม่พบคิว ACTIVE ของผู้ใช้นี้" }, { status: 404 });
      }

      // อัปเดต queue → COMPLETED
      await this.env.DB.prepare(`
        UPDATE product_queue SET status = 'COMPLETED' WHERE id = ?
      `).bind(queueRow.id).run();

      // อัปเดต booking → completed (ไม่คืน stock)
      if (queueRow.booking_id) {
        await this.env.DB.prepare(`
          UPDATE bookings SET status = 'completed' WHERE id = ?
        `).bind(queueRow.booking_id).run();
      }

      // promote คนถัดไป
      await this.promoteNext(productId);

      return Response.json({ message: "completed", bookingId: queueRow.booking_id });
    }

    // POST /leave-cancelled — ยกเลิก: queue → CANCELLED, booking → cancelled, คืน stock
    if (url.pathname.endsWith("/leave-cancelled") && method === "POST") {
      const body: any = await request.json();
      const userId = Math.floor(Number(body.user_id));
      const productId = Math.floor(Number(body.product_id));

      if (!userId || !productId) {
        return Response.json({ error: "กรุณาระบุ user_id และ product_id" }, { status: 400 });
      }

      // ดึง queue row ก่อน (เพื่อเอา booking_id)
      const queueRow = await this.env.DB.prepare(`
        SELECT id, booking_id FROM product_queue
        WHERE user_id = ? AND product_id = ? AND status IN ('ACTIVE', 'WAITING')
        ORDER BY created_at LIMIT 1
      `).bind(userId, productId).first();

      if (!queueRow) {
        return Response.json({ error: "ไม่พบคิวของผู้ใช้นี้" }, { status: 404 });
      }

      // อัปเดต queue → CANCELLED
      await this.env.DB.prepare(`
        UPDATE product_queue SET status = 'CANCELLED' WHERE id = ?
      `).bind(queueRow.id).run();

      // อัปเดต booking → cancelled + คืน stock
      if (queueRow.booking_id) {
        // ดึง quantity จาก booking เพื่อคืน stock
        const booking = await this.env.DB.prepare(`
          SELECT quantity FROM bookings WHERE id = ?
        `).bind(queueRow.booking_id).first();

        await this.env.DB.prepare(`
          UPDATE bookings SET status = 'cancelled' WHERE id = ?
        `).bind(queueRow.booking_id).run();

        // คืน available_quantity
        if (booking?.quantity) {
          await this.env.DB.prepare(`
            UPDATE productsPOC SET available_quantity = available_quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
          `).bind(booking.quantity, productId).run();
        }
      }

      // promote คนถัดไป
      await this.promoteNext(productId);

      return Response.json({ message: "cancelled", bookingId: queueRow.booking_id });
    }

    // POST /complete-booking — เหมือน BookingService.completeBooking() รับ bookingId
    // flow: หา queue จาก booking_id → queue COMPLETED → booking completed → ไม่คืน stock → promote
    if (url.pathname.endsWith("/complete-booking") && method === "POST") {
      const body: any = await request.json();
      const bookingId = Math.floor(Number(body.booking_id));

      if (!bookingId) {
        return Response.json({ error: "กรุณาระบุ booking_id" }, { status: 400 });
      }

      // ดึง booking เพื่อเช็คสถานะ
      const booking = await this.env.DB.prepare(`
        SELECT id, product_id, quantity, status FROM bookings WHERE id = ?
      `).bind(bookingId).first();

      if (!booking) {
        return Response.json({ error: "ไม่พบการจอง" }, { status: 404 });
      }
      if (booking.status === "completed" || booking.status === "cancelled") {
        return Response.json({ error: `ไม่สามารถ complete ได้ สถานะปัจจุบัน: ${booking.status}` }, { status: 400 });
      }

      // หา queue row จาก booking_id
      const queueRow = await this.env.DB.prepare(`
        SELECT id FROM product_queue WHERE booking_id = ? AND status IN ('ACTIVE', 'WAITING') LIMIT 1
      `).bind(bookingId).first();

      // อัปเดต queue → COMPLETED (ถ้ามี)
      if (queueRow) {
        // ลบ queue entry
        await this.env.DB.prepare("DELETE FROM product_queue WHERE booking_id = ?").bind(bookingId).run();
      }

      // อัปเดต booking → completed (ไม่คืน stock)
      await this.env.DB.prepare(`
        UPDATE bookings SET status = 'completed' WHERE id = ?
      `).bind(bookingId).run();

      // promote คนถัดไป
      await this.promoteNext(Math.floor(Number(booking.product_id)));

      const updated = await this.env.DB.prepare(`
        SELECT * FROM bookings WHERE id = ?
      `).bind(bookingId).first();

      return Response.json({
        booking: updated,
        message: "เสร็จสิ้นการจอง product_queue เปลี่ยนเป็น COMPLETED คิว WAITING ถัดไปได้ promote เป็น ACTIVE",
      });
    }

    // POST /cancel-booking — เหมือน BookingService.cancelBooking() รับ bookingId
    // flow: หา queue จาก booking_id → queue CANCELLED → booking cancelled → คืน stock → promote
    if (url.pathname.endsWith("/cancel-booking") && method === "POST") {
      const body: any = await request.json();
      const bookingId = Math.floor(Number(body.booking_id));

      if (!bookingId) {
        return Response.json({ error: "กรุณาระบุ booking_id" }, { status: 400 });
      }

      // ดึง booking เพื่อเช็คสถานะ + quantity
      const booking = await this.env.DB.prepare(`
        SELECT id, product_id, quantity, status FROM bookings WHERE id = ?
      `).bind(bookingId).first();

      if (!booking) {
        return Response.json({ error: "ไม่พบการจอง" }, { status: 404 });
      }
      if (booking.status === "cancelled") {
        return Response.json({ error: "การจองถูกยกเลิกแล้ว" }, { status: 400 });
      }

      // หา queue row จาก booking_id
      const queueRow = await this.env.DB.prepare(`
        SELECT id FROM product_queue WHERE booking_id = ? AND status IN ('ACTIVE', 'WAITING') LIMIT 1
      `).bind(bookingId).first();

      // อัปเดต queue → CANCELLED (ถ้ามี)
      if (queueRow) {
        // ลบ queue entry
        await this.env.DB.prepare("DELETE FROM product_queue WHERE booking_id = ?").bind(bookingId).run();
      }

      // อัปเดต booking → cancelled
      await this.env.DB.prepare(`
        UPDATE bookings SET status = 'cancelled' WHERE id = ?
      `).bind(bookingId).run();

      // คืน available_quantity
      if (booking.quantity) {
        await this.env.DB.prepare(`
          UPDATE productsPOC SET available_quantity = available_quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).bind(booking.quantity, booking.product_id).run();
      }

      // promote คนถัดไป
      await this.promoteNext(Math.floor(Number(booking.product_id)));

      const updated = await this.env.DB.prepare(`
        SELECT * FROM bookings WHERE id = ?
      `).bind(bookingId).first();

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

      const result = await this.env.DB.prepare(`
        SELECT COUNT(*) as count FROM product_queue
        WHERE product_id = ? AND status = 'ACTIVE'
      `).bind(Math.floor(Number(productId))).first();

      return Response.json({
        activeCount: result?.count ?? 0,
        limit: this.ACTIVE_LIMIT,
      });
    }

    return Response.json({ error: "Not Found" }, { status: 404 });
  }

  /** promote คนถัดไปจาก WAITING → ACTIVE ถ้ายังไม่เต็ม + อัปเดต booking เป็น booked */
  private async promoteNext(productId: number) {
    const activeCount = await this.env.DB.prepare(`
      SELECT COUNT(*) as count FROM product_queue WHERE product_id = ? AND status = 'ACTIVE'
    `).bind(productId).first();

    if ((activeCount?.count ?? 0) < this.ACTIVE_LIMIT) {
      const next = await this.env.DB.prepare(`
        SELECT id, booking_id FROM product_queue
        WHERE product_id = ? AND status = 'WAITING'
        ORDER BY created_at LIMIT 1
      `).bind(productId).first();

      if (next) {
        // promote queue → ACTIVE
        await this.env.DB.prepare(`
          UPDATE product_queue SET status = 'ACTIVE' WHERE id = ?
        `).bind(next.id).run();

        // อัปเดต booking ของคนที่ถูก promote เป็น booked
        if (next.booking_id) {
          await this.env.DB.prepare(`
            UPDATE bookings SET status = 'booked' WHERE id = ?
          `).bind(next.booking_id).run();
        }
      }
    }
  }
}
