interface QueueEntry {
  id: number;
  user_id: number;
  product_id: number;
  quantity: number;
  status: 'booked' | 'waiting';
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
const BOOKING_TIMEOUT_MS = 5 * 60 * 1000;

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

    // ลบ entries ที่หมดอายุ
    queue = queue.filter(
      (e) => !(e.status === "booked" && e.expires_at && new Date(e.expires_at).getTime() <= now)
    );

    // recalculate — promote waiting → booked
    const stock = await this.state.storage.get<StockInfo>("stock");
    if (stock) {
      this.recalculateStatuses(queue, stock);
    }

    await this.saveQueue(queue);
    await this.scheduleNextAlarm(queue);

    return queue;
  }

  /** คำนวณ status ใหม่ทั้ง queue — promote waiting → booked ถ้า effective stock พอ */
  private recalculateStatuses(queue: QueueEntry[], stock: StockInfo): void {
    let effectiveAvailable = this.getEffectiveAvailable(stock, queue.filter((e) => e.status === "booked"));

    for (const entry of queue) {
      if (entry.status === "booked") continue; // ข้าม booked ที่อยู่แล้ว
      if (entry.status === "waiting" && effectiveAvailable >= entry.quantity) {
        entry.status = "booked";
        entry.expires_at = this.createExpiresAt(); // ตั้งเวลาหมดอายุตอน promote
        effectiveAvailable -= entry.quantity;
      } else {
        break; // stock ไม่พอ ที่เหลือเป็น waiting ทั้งหมด
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

      // 2. เช็ค quantity กับ available (stock จริงที่เหลือหลังหัก complete แล้ว)
      if (quantity > stock.available_quantity) {
        return Response.json(
          { error: `ไม่สามารถจองได้ สินค้าคงเหลือไม่เพียงพอ (available_quantity = ${stock.available_quantity})` },
          { status: 400 }
        );
      }

      // 3. เช็คซ้ำ
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

      // 4. คำนวณ effective available แล้วกำหนด status (ไม่หัก stock จริง)
      // ถ้ามี waiting อยู่ก่อนหน้า → ต้อง waiting ด้วย (ห้ามข้ามคิว)
      const hasWaiting = queue.some((e) => e.status === "waiting");
      const effectiveAvailable = this.getEffectiveAvailable(stock, queue);
      const queueStatus: 'booked' | 'waiting' = (!hasWaiting && effectiveAvailable >= quantity) ? "booked" : "waiting";

      // 5. เพิ่มเข้า queue
      const queueId = await this.getNextId();
      const now = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString();
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

      // 6. หา position
      const position = queue.findIndex((e) => e.id === queueId) + 1;

      const message = queueStatus === "booked"
        ? "จองสินค้าสำเร็จ (booked)"
        : "สินค้าไม่เพียงพอ รอคิว (waiting)";

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
      this.recalculateStatuses(queue, stock);
      await this.saveQueue(queue);
      await this.scheduleNextAlarm(queue);

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

      // ลบออกจากคิว (ไม่ต้องคืน stock เพราะยังไม่ได้หัก stock จริงใน DO)
      queue.splice(idx, 1);

      // คำนวณ status ใหม่ — waiting อาจ promote เป็น booked ได้ (พร้อมตั้ง expires_at)
      this.recalculateStatuses(queue, stock);

      await this.saveQueue(queue);
      await this.scheduleNextAlarm(queue);

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

    return Response.json({ error: "Not Found" }, { status: 404 });
  }
}
