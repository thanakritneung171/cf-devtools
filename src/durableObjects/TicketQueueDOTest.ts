interface QueueEntry {
  id: number;
  user_id: number;
  product_id: number;
  quantity: number;
  status: 'booked' | 'waiting' | 'waiting_edit' | 'out_of_stock';
  created_at: string;
  expires_at: string | null; // เวลาหมดอายุ (เฉพาะ booked เท่านั้น)
}

interface StockInfo {
  product_id: number;
  product_name: string;
  description: string | null;
  price: number;
  total_quantity: number;
  available_quantity: number; // stock จริงที่เหลือ (หักเฉพาะตอน complete เท่านั้น)
}

// กำหนดเวลาหมดอายุการจอง (5 นาที)
const BOOKING_TIMEOUT_MS = 2.5 * 60 * 1000;

export class TicketQueueDOTest {
  state: DurableObjectState;
  env: any;

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

  /** ดึง stock จาก DO storage — ถ้ายังไม่มีจะดึงจาก D1 มาเก็บ */
  private async getStock(productId: number): Promise<StockInfo | null> {
    let stock = await this.state.storage.get<StockInfo>("stock");
    if (!stock) {
      const product = await this.env.DB.prepare(
        "SELECT id, product_name, description, price, total_quantity, available_quantity FROM productsPOC WHERE id = ?"
      ).bind(productId).first();

      if (!product) return null;

      stock = {
        product_id: product.id,
        product_name: product.product_name,
        description: product.description || null,
        price: product.price,
        total_quantity: product.total_quantity,
        available_quantity: product.available_quantity,
      };
      await this.state.storage.put("stock", stock);
    }
    return stock;
  }

  private async saveStock(stock: StockInfo): Promise<void> {
    await this.state.storage.put("stock", stock);
  }

  /** คำนวณ effective available = stock จริง - sum(booked ที่ยังไม่ complete) */
  private getEffectiveAvailable(stock: StockInfo, queue: QueueEntry[]): number {
    const bookedTotal = queue
      .filter((e) => e.status === "booked")
      .reduce((sum, e) => sum + e.quantity, 0);
    return stock.available_quantity - bookedTotal;
  }

  /** สร้าง expires_at จากเวลาปัจจุบัน + timeout */
  private createExpiresAt(): string {
    return new Date(Date.now() + BOOKING_TIMEOUT_MS).toISOString();
  }

  /** คำนวณเวลาที่เหลือ (วินาที) จาก expires_at — ถ้าหมดแล้วคืน 0 */
  private getTimeRemaining(expiresAt: string | null): number {
    if (!expiresAt) return 0;
    const remaining = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
    return remaining;
  }

  /** ตั้ง alarm ให้ตรงกับเวลาหมดอายุที่เร็วที่สุดใน queue */
  private async scheduleNextAlarm(queue: QueueEntry[]): Promise<void> {
    const bookedWithExpiry = queue
      .filter((e) => e.status === "booked" && e.expires_at)
      .map((e) => new Date(e.expires_at!).getTime())
      .sort((a, b) => a - b);

    if (bookedWithExpiry.length > 0) {
      const nextExpiry = bookedWithExpiry[0];
      // ตั้ง alarm ที่เวลาหมดอายุตัวแรก (หรือทันทีถ้าเลยเวลาแล้ว)
      const alarmTime = Math.max(nextExpiry, Date.now() + 1000);
      await this.state.storage.setAlarm(alarmTime);
    } else {
      // ไม่มี booked ที่มี expiry → ลบ alarm
      await this.state.storage.deleteAlarm();
    }
  }

  /** ลบ queue entries ที่หมดอายุ + recalculate statuses */
  private async processExpired(): Promise<QueueEntry[]> {
    let queue = await this.getQueue();
    const now = Date.now();

    const expired = queue.filter(
      (e) => e.status === "booked" && e.expires_at && new Date(e.expires_at).getTime() <= now
    );

    if (expired.length === 0) return queue;

    // แจ้ง user ที่หมดเวลาก่อนลบออกจากคิว
    for (const e of expired) {
      await this.pushNotification(e.user_id, {
        type: 'queue_status_changed',
        product_id: e.product_id,
        queue_id: e.id,
        status: 'expired',
        message: 'หมดเวลาการจองของคุณแล้ว คิวของคุณถูกยกเลิกอัตโนมัติ',
      });
    }

    // ลบ entries ที่หมดอายุ
    queue = queue.filter(
      (e) => !(e.status === "booked" && e.expires_at && new Date(e.expires_at).getTime() <= now)
    );

    // recalculate — promote waiting → booked
    const stock = await this.state.storage.get<StockInfo>("stock");
    if (stock) {
      const beforeMap = new Map(queue.map((e) => [e.id, e.status]));
      this.recalculateStatuses(queue, stock);
      await this.saveQueue(queue);
      await this.scheduleNextAlarm(queue);
      // แจ้ง user ที่ถูก promote (productId จาก stock)
      await this.notifyPromotedUsers(beforeMap, queue, stock.product_id);
    } else {
      await this.saveQueue(queue);
      await this.scheduleNextAlarm(queue);
    }

    return queue;
  }

  /** คำนวณ status ใหม่ทั้ง queue — promote waiting → booked ถ้า effective stock พอ */
  private recalculateStatuses(queue: QueueEntry[], stock: StockInfo): void {
    let effectiveAvailable = this.getEffectiveAvailable(stock, queue.filter((e) => e.status === "booked"));
    // ติดตาม anyBooked แบบ realtime — อัปเดตทุกครั้งที่ promote หรือเจอ booked เดิม
    let anyBooked = queue.some((e) => e.status === "booked");
    let firstWaitingMarked = false;
    // เมื่อ entry ใด promote ไม่ได้ (FIFO) — entry ถัดไปทั้งหมดต้องรอด้วย
    let canPromote = true;

    for (const entry of queue) {
      if (entry.status === "booked") {
        anyBooked = true;
        continue;
      }

      if (canPromote && effectiveAvailable >= entry.quantity) {
        entry.status = "booked";
        entry.expires_at = this.createExpiresAt();
        effectiveAvailable -= entry.quantity;
        anyBooked = true; // update ทันทีที่ promote
      } else {
        // บล็อก promotion ของ entry ถัดไปทั้งหมด (queue เป็น FIFO)
        canPromote = false;
        // stock ไม่พอ — กำหนด special status เฉพาะเมื่อไม่มี booked ใดๆ ในคิว
        if (!firstWaitingMarked && !anyBooked) {
          entry.status = stock.available_quantity === 0 ? "out_of_stock" : "waiting_edit";
          firstWaitingMarked = true;
        } else {
          entry.status = "waiting";
        }
        entry.expires_at = null;
      }
    }
  }

  /** ส่ง notification ไปยัง user คนเดียว — helper ลด code ซ้ำ */
  private async pushNotification(userId: number, payload: object): Promise<void> {
    if (!this.env.NOTIFICATION_DO) return;
    try {
      const doId = this.env.NOTIFICATION_DO.idFromName(userId.toString());
      const stub = this.env.NOTIFICATION_DO.get(doId);
      await stub.fetch('https://notification-do/push', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    } catch {
      // ไม่ fail ถ้า notification ส่งไม่ได้
    }
  }

  /**
   * ส่ง notification ไปยัง user ที่ status เปลี่ยน หลัง recalculateStatuses
   * ครอบคลุม: booked (ถึงคิว), waiting_edit (ต้องแก้จำนวน), out_of_stock (สินค้าหมด)
   * เรียกหลัง recalculateStatuses + saveQueue เสมอ
   */
  private async notifyPromotedUsers(
    beforeMap: Map<number, string>,
    afterQueue: QueueEntry[],
    productId: number
  ): Promise<void> {
    if (!this.env.NOTIFICATION_DO) return;

    const stock = await this.state.storage.get<StockInfo>("stock");
    const productName = stock?.product_name || null;

    const notifyMap: Record<string, { message: string }> = {
      booked: { message: 'ถึงคิวคุณแล้ว! กรุณายืนยันการจองก่อนหมดเวลา' },
      waiting_edit: { message: 'ถึงคิวคุณแล้ว แต่จำนวนที่จองเกินสินค้าที่เหลือ กรุณาแก้ไขจำนวน' },
      out_of_stock: { message: 'ถึงคิวคุณแล้ว แต่สินค้าหมดแล้ว กรุณาตรวจสอบ' },
    };

    for (const entry of afterQueue) {
      const oldStatus = beforeMap.get(entry.id);
      const notifyInfo = notifyMap[entry.status];

      if (notifyInfo && oldStatus !== entry.status) {
        await this.pushNotification(entry.user_id, {
          type: 'queue_status_changed',
          product_id: productId,
          product_name: productName,
          queue_id: entry.id,
          status: entry.status,
          message: notifyInfo.message,
          expires_at: entry.expires_at,
        });
      }
    }
  }

  /** เพิ่ม time_remaining ให้ queue entry */
  private enrichWithTimeRemaining(entry: QueueEntry): any {
    return {
      ...entry,
      time_remaining_seconds: entry.status === "booked" ? this.getTimeRemaining(entry.expires_at) : null,
    };
  }

  // ===== Alarm handler — auto-cancel expired bookings =====

  async alarm() {
    await this.processExpired();
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    const method = request.method;

    // ทุก request — เช็ค expired ก่อน
    await this.processExpired();

    // ========== POST /create-booking — เข้าคิว (ไม่หัก stock, ไม่สร้าง booking ใน D1) ==========
    if (url.pathname.endsWith("/create-booking") && method === "POST") {
      const body: any = await request.json();
      const userId = Math.floor(Number(body.user_id));
      const productId = Math.floor(Number(body.product_id));
      const quantity = Math.floor(Number(body.quantity));

      if (!userId || !productId || !quantity) {
        return Response.json({ error: "กรุณาระบุ user_id, product_id, quantity" }, { status: 400 });
      }

      // 1. ดึง stock (ครั้งแรกจะ init จาก D1)
      const stock = await this.getStock(productId);
      if (!stock) {
        return Response.json({ error: "ไม่พบสินค้า" }, { status: 404 });
      }

      // 2. เช็คซ้ำ
      const queue = await this.getQueue();
      const existing = queue.find(
        (e) => e.product_id === productId && e.user_id === userId
      );
      if (existing) {
        return Response.json(
          { error: `ผู้ใช้ ${userId} มีคิวอยู่แล้วสำหรับสินค้า ${productId} ไม่สามารถจองซ้ำได้` },
          { status: 409 }
        );
      }

      // 3. คำนวณ effective available แล้วกำหนด status
      const hasWaiting = queue.some((e) => e.status === "waiting" || e.status === "waiting_edit" || e.status === "out_of_stock");
      const hasBooked = queue.some((e) => e.status === "booked");
      const effectiveAvailable = this.getEffectiveAvailable(stock, queue);

      let queueStatus: QueueEntry['status'];
      if (!hasWaiting && effectiveAvailable >= quantity) {
        queueStatus = "booked";
      } else if (stock.available_quantity === 0 && !hasBooked && !hasWaiting) {
        queueStatus = "out_of_stock";
      } else if (quantity > effectiveAvailable && !hasBooked && !hasWaiting) {
        queueStatus = "waiting_edit";
      } else {
        queueStatus = "waiting";
      }

      // 4. เพิ่มเข้า queue
      const queueId = await this.getNextId();
      const now = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
      const newEntry: QueueEntry = {
        id: queueId,
        user_id: userId,
        product_id: productId,
        quantity,
        status: queueStatus,
        created_at: now,
        expires_at: queueStatus === "booked" ? this.createExpiresAt() : null,
      };
      queue.push(newEntry);
      await this.saveQueue(queue);

      // ตั้ง alarm ถ้ามี booked
      await this.scheduleNextAlarm(queue);

      // 5. หา position
      const position = queue.findIndex((e) => e.id === queueId) + 1;

      const messageMap: Record<string, string> = {
        booked: "จองสินค้าสำเร็จ (booked)",
        waiting: "สินค้าไม่เพียงพอ รอคิว (waiting)",
        waiting_edit: "จำนวนมากกว่าสินค้าคงเหลือ กรุณาแก้ไขจำนวน (waiting_edit)",
        out_of_stock: "สินค้าหมด (out_of_stock)",
      };
      const message = messageMap[queueStatus] || "เข้าคิวสำเร็จ";

      return Response.json({
        queue_entry: this.enrichWithTimeRemaining(newEntry),
        queue_position: position,
        effective_available: effectiveAvailable - (queueStatus === "booked" ? quantity : 0),
        stock_available: stock.available_quantity,
        message,
      }, { status: 201 });
    }

    // ========== POST /complete-booking — หัก stock ใน DO + สร้าง booking ใน D1 + อัปเดต productsPOC ==========
    if (url.pathname.endsWith("/complete-booking") && method === "POST") {
      const body: any = await request.json();
      const queueId = Math.floor(Number(body.queue_id));

      if (!queueId) {
        return Response.json({ error: "กรุณาระบุ queue_id" }, { status: 400 });
      }

      const queue = await this.getQueue();
      const idx = queue.findIndex((e) => e.id === queueId);

      if (idx === -1) {
        return Response.json({ error: "ไม่พบคิวนี้" }, { status: 404 });
      }

      const entry = queue[idx];

      if (entry.status !== "booked") {
        return Response.json({ error: `ไม่สามารถ complete ได้ สถานะปัจจุบัน: ${entry.status}` }, { status: 400 });
      }

      // 1. หัก stock ใน DO (ตอนนี้ค่อยหักจริง)
      const stock = await this.getStock(entry.product_id);
      if (!stock) {
        return Response.json({ error: "ไม่พบข้อมูล stock" }, { status: 500 });
      }
      stock.available_quantity -= entry.quantity;
      await this.saveStock(stock);

      // 2. สร้าง booking ใน D1
      const bookingResult = await this.env.DB.prepare(
        "INSERT INTO bookings (user_id, product_id, quantity, status) VALUES (?, ?, ?, 'completed')"
      ).bind(entry.user_id, entry.product_id, entry.quantity).run();

      const bookingId = bookingResult.meta.last_row_id;

      // 3. อัปเดต productsPOC ใน D1 (sync stock)
      await this.env.DB.prepare(
        "UPDATE productsPOC SET available_quantity = available_quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(entry.quantity, entry.product_id).run();

      // 4. ลบออกจากคิว
      queue.splice(idx, 1);

      // 5. recalculate + ตั้ง alarm ใหม่
      const beforeMapComplete = new Map(queue.map((e) => [e.id, e.status]));
      this.recalculateStatuses(queue, stock);
      await this.saveQueue(queue);
      await this.scheduleNextAlarm(queue);
      await this.notifyPromotedUsers(beforeMapComplete, queue, entry.product_id);

      const booking = await this.env.DB.prepare(
        "SELECT * FROM bookings WHERE id = ?"
      ).bind(bookingId).first();

      return Response.json({
        booking,
        stock_remaining: stock.available_quantity,
        message: "เสร็จสิ้นการจอง หัก stock + สร้าง booking ใน D1 แล้ว",
      });
    }

    // ========== POST /cancel-booking — ลบออกจากคิว + recalculate statuses ==========
    if (url.pathname.endsWith("/cancel-booking") && method === "POST") {
      const body: any = await request.json();
      const queueId = Math.floor(Number(body.queue_id));

      if (!queueId) {
        return Response.json({ error: "กรุณาระบุ queue_id" }, { status: 400 });
      }

      const queue = await this.getQueue();
      const idx = queue.findIndex((e) => e.id === queueId);

      if (idx === -1) {
        return Response.json({ error: "ไม่พบคิวนี้" }, { status: 404 });
      }

      const entry = queue[idx];
      const stock = await this.getStock(entry.product_id);
      if (!stock) {
        return Response.json({ error: "ไม่พบข้อมูล stock" }, { status: 500 });
      }

      // แจ้ง user ที่ถูกยกเลิกคิว
      await this.pushNotification(entry.user_id, {
        type: 'queue_status_changed',
        product_id: entry.product_id,
        queue_id: entry.id,
        status: 'cancelled',
        message: 'คิวของคุณถูกยกเลิกแล้ว',
      });

      // ลบออกจากคิว (ไม่ต้องคืน stock เพราะยังไม่ได้หัก stock จริงใน DO)
      queue.splice(idx, 1);

      // คำนวณ status ใหม่ — waiting อาจ promote เป็น booked ได้ (พร้อมตั้ง expires_at)
      const beforeMapCancel = new Map(queue.map((e) => [e.id, e.status]));
      this.recalculateStatuses(queue, stock);

      await this.saveQueue(queue);
      await this.scheduleNextAlarm(queue);
      await this.notifyPromotedUsers(beforeMapCancel, queue, entry.product_id);

      const effectiveAvailable = this.getEffectiveAvailable(stock, queue);

      return Response.json({
        message: "ยกเลิกคิวสำเร็จ",
        cancelled_entry: entry,
        stock_available: stock.available_quantity,
        effective_available: effectiveAvailable,
      });
    }

    // ========== GET /queue/status — เช็คสถานะคิวของ user ==========
    if (url.pathname.endsWith("/queue/status") && method === "GET") {
      const userId = url.searchParams.get("user_id");
      const productId = url.searchParams.get("product_id");

      if (!userId || !productId) {
        return Response.json({ error: "Missing user_id or product_id" }, { status: 400 });
      }

      const uid = Math.floor(Number(userId));
      const pid = Math.floor(Number(productId));
      const queue = await this.getQueue();
      const idx = queue.findIndex((e) => e.user_id === uid && e.product_id === pid);

      if (idx === -1) {
        return Response.json({ error: "ไม่พบคิวของผู้ใช้นี้" }, { status: 404 });
      }

      const user = await this.env.DB.prepare(
        "SELECT id, first_name, last_name, email FROM users WHERE id = ?"
      ).bind(uid).first();

      const stock = await this.getStock(pid);
      const entry = queue[idx];

      // คำนวณข้อมูลสำหรับ waiting
      const bookedBeforeMe = queue.slice(0, idx).filter((e) => e.status === "booked");
      const waitingBeforeMe = queue.slice(0, idx).filter((e) => e.status === "waiting");

      // stock ที่จะว่างหลังคน booked ก่อนหน้า complete ทุกคน
      const stockIfAllComplete = stock ? stock.available_quantity : 0;

      // waiting ก่อนหน้าฉัน จอง quantity รวมเท่าไหร่
      const waitingBeforeQuantity = waitingBeforeMe.reduce((sum, e) => sum + e.quantity, 0);

      // stock ที่จะถึงคิวฉัน = stock หลัง complete ทุกคน - waiting ก่อนหน้าฉัน
      const stockWhenMyTurn = stockIfAllComplete - waitingBeforeQuantity;

      return Response.json({
        queue_entry: this.enrichWithTimeRemaining(entry),
        user: user || null,
        position: idx + 1,
        total_in_queue: queue.length,
        waiting_ahead: waitingBeforeMe.length,
        booked_ahead: bookedBeforeMe.length,
        stock_available: stock?.available_quantity ?? 0,
        stock_when_my_turn: stockWhenMyTurn,
        can_book: entry.status === "booked" || stockWhenMyTurn >= entry.quantity,
        effective_available: stock ? this.getEffectiveAvailable(stock, queue) : 0,
      });
    }

    // ========== GET /queue/all — ดู queue ทั้งหมด + JOIN user data ==========
    if (url.pathname.endsWith("/queue/all") && method === "GET") {
      const queue = await this.getQueue();
      const stock = await this.state.storage.get<StockInfo>("stock");

      // JOIN ข้อมูล user จาก D1
      const userIds = [...new Set(queue.map((e) => e.user_id))];
      const userMap: Record<number, any> = {};

      for (const uid of userIds) {
        const user = await this.env.DB.prepare(
          "SELECT id, first_name, last_name, email FROM users WHERE id = ?"
        ).bind(uid).first();
        if (user) userMap[uid] = user;
      }

      const enriched = queue.map((e) => ({
        ...this.enrichWithTimeRemaining(e),
        user: userMap[e.user_id] || null,
      }));

      return Response.json({
        queue: enriched,
        total: queue.length,
        booked_count: queue.filter((e) => e.status === "booked").length,
        waiting_count: queue.filter((e) => e.status === "waiting").length,
        waiting_edit_count: queue.filter((e) => e.status === "waiting_edit").length,
        out_of_stock_count: queue.filter((e) => e.status === "out_of_stock").length,
        stock: stock || null,
        effective_available: stock ? this.getEffectiveAvailable(stock, queue) : 0,
      });
    }

    // ========== GET /queue/stock — ดู stock ปัจจุบันใน DO ==========
    if (url.pathname.endsWith("/queue/stock") && method === "GET") {
      const stock = await this.state.storage.get<StockInfo>("stock");

      if (!stock) {
        return Response.json({ error: "ยังไม่มีข้อมูล stock ใน DO (ยังไม่เคยมี booking)" }, { status: 404 });
      }

      const queue = await this.getQueue();
      const effectiveAvailable = this.getEffectiveAvailable(stock, queue);

      // คำนวณ detail แต่ละ queue entry — บอกว่าค้างเพราะอะไร + เวลาที่เหลือ
      let runningEffective = effectiveAvailable;
      const queueDetail = queue.map((entry, idx) => {
        const enriched = this.enrichWithTimeRemaining(entry);

        if (entry.status === "booked") {
          return {
            ...enriched,
            reason: "stock เพียงพอ รอ complete",
          };
        }

        // หาว่ามี waiting ก่อนหน้าไหม
        const waitingBefore = queue.slice(0, idx).filter((e) => e.status === "waiting");

        if (waitingBefore.length > 0) {
          return {
            ...enriched,
            waiting_ahead: waitingBefore.length,
            reason: `รอคิวก่อนหน้าอีก ${waitingBefore.length} คิว`,
          };
        }

        if (runningEffective < entry.quantity) {
          return {
            ...enriched,
            need: entry.quantity,
            available: runningEffective,
            short: entry.quantity - runningEffective,
            reason: `stock ไม่พอ ต้องการ ${entry.quantity} แต่เหลือว่าง ${runningEffective} (ขาดอีก ${entry.quantity - runningEffective})`,
          };
        }

        return { ...enriched, reason: "รอ promote" };
      });

      // หาจุดที่คิวค้าง
      const firstWaiting = queue.findIndex((e) => e.status === "waiting");
      let blocked_at = null;
      if (firstWaiting !== -1) {
        const entry = queue[firstWaiting];
        blocked_at = {
          queue_id: entry.id,
          user_id: entry.user_id,
          position: firstWaiting + 1,
          quantity: entry.quantity,
          effective_available: effectiveAvailable,
          short: entry.quantity - effectiveAvailable,
          reason: `คิวค้างที่ตำแหน่ง ${firstWaiting + 1} (queue_id: ${entry.id}) — ต้องการ ${entry.quantity} แต่เหลือว่าง ${effectiveAvailable} (ขาดอีก ${entry.quantity - effectiveAvailable})`,
        };
      }

      return Response.json({
        stock,
        booked_count: queue.filter((e) => e.status === "booked").length,
        waiting_count: queue.filter((e) => e.status === "waiting").length,
        booked_quantity: queue.filter((e) => e.status === "booked").reduce((sum, e) => sum + e.quantity, 0),
        effective_available: effectiveAvailable,
        booking_timeout_minutes: BOOKING_TIMEOUT_MS / 60000,
        blocked_at,
        queue: queueDetail,
      });
    }

    // ========== PUT /sync-stock — sync stock จากภายนอก + recalculate statuses ==========
    if (url.pathname.endsWith("/sync-stock") && method === "PUT") {
      const body: any = await request.json();
      const newTotalQuantity = Math.floor(Number(body.total_quantity));
      const newAvailableQuantity = Math.floor(Number(body.available_quantity));

      if (isNaN(newTotalQuantity) || isNaN(newAvailableQuantity)) {
        return Response.json({ error: "กรุณาระบุ total_quantity และ available_quantity" }, { status: 400 });
      }

      const stock = await this.state.storage.get<StockInfo>("stock");
      if (!stock) {
        // DO ยังไม่เคย init (ยังไม่มีคิว) — ไม่มีอะไรต้อง sync
        return Response.json({ message: "ยังไม่มี stock ใน DO (ไม่มีคิว)" }, { status: 200 });
      }

      stock.total_quantity = newTotalQuantity;
      stock.available_quantity = newAvailableQuantity;
      await this.saveStock(stock);

      const queue = await this.getQueue();
      const beforeMapSync = new Map(queue.map((e) => [e.id, e.status]));
      this.recalculateStatuses(queue, stock);
      await this.saveQueue(queue);
      await this.scheduleNextAlarm(queue);
      await this.notifyPromotedUsers(beforeMapSync, queue, stock.product_id);

      const effectiveAvailable = this.getEffectiveAvailable(stock, queue);

      return Response.json({
        message: "sync stock สำเร็จ",
        stock,
        effective_available: effectiveAvailable,
        booked_count: queue.filter((e) => e.status === "booked").length,
        waiting_count: queue.filter((e) => e.status === "waiting").length,
      });
    }

    // ========== PUT /edit-quantity — แก้ไขจำนวนของ waiting_edit entry ==========
    if (url.pathname.endsWith("/edit-quantity") && method === "PUT") {
      const body: any = await request.json();
      const queueId = Math.floor(Number(body.queue_id));
      const newQuantity = Math.floor(Number(body.quantity));

      if (!queueId || !newQuantity) {
        return Response.json({ error: "กรุณาระบุ queue_id และ quantity" }, { status: 400 });
      }

      const queue = await this.getQueue();
      const idx = queue.findIndex((e) => e.id === queueId);
      if (idx === -1) {
        return Response.json({ error: "ไม่พบคิวนี้" }, { status: 404 });
      }

      const entry = queue[idx];
      if (entry.status !== "waiting_edit") {
        return Response.json({ error: `แก้ไขจำนวนได้เฉพาะ waiting_edit เท่านั้น (สถานะปัจจุบัน: ${entry.status})` }, { status: 400 });
      }

      const stock = await this.getStock(entry.product_id);
      if (!stock) {
        return Response.json({ error: "ไม่พบข้อมูล stock" }, { status: 500 });
      }

      entry.quantity = newQuantity;
      // recalculate — อาจ promote เป็น booked ได้ถ้า qty ใหม่พอ
      const beforeMapEdit = new Map(queue.map((e) => [e.id, e.status]));
      this.recalculateStatuses(queue, stock);
      await this.saveQueue(queue);
      await this.scheduleNextAlarm(queue);
      await this.notifyPromotedUsers(beforeMapEdit, queue, entry.product_id);

      const updated = queue.find((e) => e.id === queueId);
      return Response.json({
        queue_entry: updated ? this.enrichWithTimeRemaining(updated) : null,
        message: `อัปเดตจำนวนเป็น ${newQuantity} แล้ว`,
      });
    }

    return Response.json({ error: "Not Found" }, { status: 404 });
  }
}
