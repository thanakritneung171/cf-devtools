import { ProductQueue } from '../types/productPOC';

interface Env {
  DB: D1Database;
}

export class ProductQueueService {
  private db: D1Database;
  private ACTIVE_LIMIT = 2;

  constructor(env: Env) {
    this.db = env.DB;
  }

  // นับจำนวน ACTIVE ของ product (เหมือน DO)
  async getActiveCount(productId: number): Promise<number> {
    const result = await this.db
      .prepare("SELECT COUNT(*) as count FROM product_queue WHERE product_id = ? AND status = 'ACTIVE'")
      .bind(productId)
      .first<{ count: number }>();
    return result?.count || 0;
  }

  // POST /join — logic เหมือน ProductQueueDO.ts เป๊ะ (เพิ่ม booking_id)
  async join(productId: number, userId: number, bookingId?: number): Promise<{ status: string; position: number }> {
    const pid = Math.floor(productId);
    const uid = Math.floor(userId);
    const bid = bookingId != null ? Math.floor(bookingId) : null;

    // เช็คซ้ำ — ถ้า user มีคิวอยู่แล้วใน product เดียวกัน (ACTIVE/WAITING) ห้ามจองซ้ำ
    const existing = await this.db
      .prepare("SELECT id FROM product_queue WHERE product_id = ? AND user_id = ? AND status IN ('ACTIVE', 'WAITING') LIMIT 1")
      .bind(pid, uid)
      .first<{ id: number }>();

    if (existing) {
      throw new Error(`ผู้ใช้ ${uid} มีคิวอยู่แล้วสำหรับสินค้า ${pid} ไม่สามารถจองซ้ำได้`);
    }

    // เช็ค ACTIVE count (เหมือน DO)
    const active = await this.db
      .prepare("SELECT COUNT(*) as count FROM product_queue WHERE product_id = ? AND status = 'ACTIVE'")
      .bind(pid)
      .first<{ count: number }>();

    let status = 'WAITING';
    if ((active?.count || 0) < this.ACTIVE_LIMIT) {
      status = 'ACTIVE';
    }

    // INSERT (เหมือน DO + booking_id)
    await this.db
      .prepare("INSERT INTO product_queue (product_id, user_id, booking_id, status, created_at) VALUES (?, ?, ?, ?, datetime('now', '+7 hours'))")
      .bind(pid, uid, bid, status)
      .run();

    // get current row (เหมือน DO)
    const current = await this.db
      .prepare("SELECT id FROM product_queue WHERE product_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1")
      .bind(pid, uid)
      .first<{ id: number }>();

    // position (เหมือน DO)
    const position = await this.db
      .prepare("SELECT COUNT(*) as pos FROM product_queue WHERE product_id = ? AND id <= ?")
      .bind(pid, current!.id)
      .first<{ pos: number }>();

    return { status, position: position!.pos };
  }

  // GET /queue/status — logic เหมือน ProductQueueDO.ts เป๊ะ
  async getQueueStatus(productId: string, userId: string): Promise<{
    inQueue: boolean;
    position: number | null;
    peopleAhead: number | null;
    total: number;
  }> {
    const pid = Math.floor(Number(productId));
    const uid = Math.floor(Number(userId));

    // รวม queue ทั้งหมด (เหมือน DO)
    const allQueueResult = await this.db
      .prepare(`
        SELECT user_id
        FROM product_queue
        WHERE product_id = ?
        AND status IN ('ACTIVE', 'WAITING')
        ORDER BY created_at
      `)
      .bind(pid)
      .all<{ user_id: number }>();

    const queue = allQueueResult.results || [];

    // หา position (เหมือน DO)
    const index = queue.findIndex(q => q.user_id === uid);

    let position: number | null = null;
    let peopleAhead: number | null = null;
    const total = queue.length;

    if (index !== -1) {
      position = index + 1;
      peopleAhead = index;
    }

    return { inQueue: index !== -1, position, peopleAhead, total };
  }

  // POST /leave — logic เหมือน ProductQueueDO.ts เป๊ะ (DELETE + promote)
  async leave(userId: number, productId: number): Promise<{ message: string }> {
    // remove user (เหมือน DO)
    await this.db
      .prepare(`
        DELETE FROM product_queue
        WHERE id = (
          SELECT id FROM product_queue WHERE user_id = ? AND product_id = ? ORDER BY created_at LIMIT 1
        )
      `)
      .bind(userId, productId)
      .run();

    // check active count (เหมือน DO)
    const activeCount = await this.db
      .prepare("SELECT COUNT(*) as count FROM product_queue WHERE product_id = ? AND status = 'ACTIVE'")
      .bind(productId)
      .first<{ count: number }>();

    if ((activeCount?.count || 0) < 2) {
      const next = await this.db
        .prepare("SELECT id FROM product_queue WHERE product_id = ? AND status = 'WAITING' ORDER BY created_at LIMIT 1")
        .bind(productId)
        .first<{ id: number }>();

      if (next) {
        await this.db
          .prepare("UPDATE product_queue SET status = 'ACTIVE' WHERE id = ?")
          .bind(next.id)
          .run();
      }
    }

    return { message: 'left queue' };
  }

  // === เพิ่มเติมสำหรับ BookingService (ใช้ leave logic เดียวกับ DO) ===

  // leave แบบ completed — ลบ product_queue + promote WAITING ถัดไป (เหมือน DO /leave)
  async leaveCompleted(bookingId: number, productId: number): Promise<void> {
    await this.db
      .prepare("DELETE FROM product_queue WHERE booking_id = ?")
      .bind(bookingId)
      .run();

    // promote logic เหมือน DO /leave
    const activeCount = await this.db
      .prepare("SELECT COUNT(*) as count FROM product_queue WHERE product_id = ? AND status = 'ACTIVE'")
      .bind(productId)
      .first<{ count: number }>();

    if ((activeCount?.count || 0) < 2) {
      const next = await this.db
        .prepare("SELECT id, booking_id FROM product_queue WHERE product_id = ? AND status = 'WAITING' ORDER BY created_at LIMIT 1")
        .bind(productId)
        .first<{ id: number; booking_id: number }>();

      if (next) {
        await this.db
          .prepare("UPDATE product_queue SET status = 'ACTIVE' WHERE id = ?")
          .bind(next.id)
          .run();
        // อัปเดต booking ที่เชื่อมกันด้วย
        await this.db
          .prepare("UPDATE bookings SET status = 'booked' WHERE id = ?")
          .bind(next.booking_id)
          .run();
      }
    }
  }

  // leave แบบ cancelled — DELETE (เหมือน DO) + promote WAITING ถัดไป
  async leaveCancelled(bookingId: number, productId: number): Promise<void> {
    await this.db
      .prepare("DELETE FROM product_queue WHERE booking_id = ?")
      .bind(bookingId)
      .run();

    // promote logic เหมือน DO /leave
    const activeCount = await this.db
      .prepare("SELECT COUNT(*) as count FROM product_queue WHERE product_id = ? AND status = 'ACTIVE'")
      .bind(productId)
      .first<{ count: number }>();

    if ((activeCount?.count || 0) < 2) {
      const next = await this.db
        .prepare("SELECT id, booking_id FROM product_queue WHERE product_id = ? AND status = 'WAITING' ORDER BY created_at LIMIT 1")
        .bind(productId)
        .first<{ id: number; booking_id: number }>();

      if (next) {
        await this.db
          .prepare("UPDATE product_queue SET status = 'ACTIVE' WHERE id = ?")
          .bind(next.id)
          .run();
        await this.db
          .prepare("UPDATE bookings SET status = 'booked' WHERE id = ?")
          .bind(next.booking_id)
          .run();
      }
    }
  }

  // ดูคิวตาม booking_id
  async getByBookingId(bookingId: number): Promise<ProductQueue | null> {
    return await this.db
      .prepare('SELECT * FROM product_queue WHERE booking_id = ?')
      .bind(bookingId)
      .first<ProductQueue>() || null;
  }
}
