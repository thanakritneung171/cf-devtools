import { Booking, CreateBookingInput } from '../types/productPOC';
import { ProductQueueService } from './ProductQueueService';

interface Env {
  DB: D1Database;
}

export class BookingService {
  private db: D1Database;
  private productQueueService: ProductQueueService;

  constructor(env: Env) {
    this.db = env.DB;
    this.productQueueService = new ProductQueueService(env);
  }

  async createBooking(data: CreateBookingInput): Promise<{ booking: Booking; queue_status: string; queue_position: number; message: string }> {
    // แปลงเป็น integer ป้องกันทศนิยม
    const userId = Math.floor(data.user_id);
    const productId = Math.floor(data.product_id);
    const quantity = Math.floor(data.quantity);

    // เช็คสินค้า
    const product = await this.db
      .prepare('SELECT * FROM productsPOC WHERE id = ?')
      .bind(productId)
      .first<any>();

    if (!product) {
      throw new Error('ไม่พบสินค้า');
    }

    // เช็คว่าจองเกิน total_quantity ไม่ได้
    if (quantity > product.total_quantity) {
      throw new Error(`ไม่สามารถจองเกินจำนวนสูงสุดได้ (total_quantity = ${product.total_quantity})`);
    }

    // เช็คว่าจองได้แค่ available_quantity
    if (quantity > product.available_quantity) {
      throw new Error(`สินค้าไม่เพียงพอ (available_quantity = ${product.available_quantity})`);
    }

    // === เช็คซ้ำก่อน — ถ้า user มีคิวอยู่แล้วใน product เดียวกัน (ACTIVE/WAITING) ห้ามจองซ้ำ ===
    const existingQueue = await this.db
      .prepare("SELECT id FROM product_queue WHERE product_id = ? AND user_id = ? AND status IN ('ACTIVE', 'WAITING') LIMIT 1")
      .bind(productId, userId)
      .first<{ id: number }>();

    if (existingQueue) {
      throw new Error(`ผู้ใช้ ${userId} มีคิวอยู่แล้วสำหรับสินค้า ${productId} ไม่สามารถจองซ้ำได้`);
    }

    // นับ ACTIVE ของ product_id นี้
    const activeCount = await this.productQueueService.getActiveCount(productId);

    // กำหนด status ตามเงื่อนไข ACTIVE < 2
    const bookingStatus = activeCount < 2 ? 'booked' : 'WAITING';

    // สร้าง booking
    const result = await this.db
      .prepare('INSERT INTO bookings (user_id, product_id, quantity, status) VALUES (?, ?, ?, ?)')
      .bind(userId, productId, quantity, bookingStatus)
      .run();

    const bookingId = result.meta.last_row_id;

    // ลด available_quantity
    await this.db
      .prepare('UPDATE productsPOC SET available_quantity = available_quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(quantity, productId)
      .run();

    // เพิ่มเข้า product_queue พร้อม booking_id
    const queueResult = await this.productQueueService.join(productId, userId, bookingId!);

    const booking = await this.db
      .prepare('SELECT * FROM bookings WHERE id = ?')
      .bind(bookingId)
      .first<Booking>();

    const message = bookingStatus === 'booked'
      ? 'จองสินค้าสำเร็จ (ACTIVE)'
      : 'สินค้าถูกจอง แต่คิวเต็ม รอคิว (WAITING)';

    return {
      booking: booking!,
      queue_status: queueResult.status,
      queue_position: queueResult.position,
      message,
    };
  }

  // Complete booking — ใช้ /leave logic, ไม่คืน stock
  async completeBooking(id: number): Promise<Booking | null> {
    const booking = await this.db
      .prepare('SELECT * FROM bookings WHERE id = ?')
      .bind(id)
      .first<Booking>();

    if (!booking || booking.status === 'cancelled' || booking.status === 'completed') return null;

    // อัปเดต booking.status = completed
    await this.db
      .prepare("UPDATE bookings SET status = 'completed' WHERE id = ?")
      .bind(id)
      .run();

    // product_queue: leave completed (ไม่คืน stock, promote WAITING ถัดไป)
    await this.productQueueService.leaveCompleted(id, booking.product_id);

    return await this.db
      .prepare('SELECT * FROM bookings WHERE id = ?')
      .bind(id)
      .first<Booking>() || null;
  }

  // Cancel booking — ใช้ /leave logic, คืน stock + ลบ product_queue
  async cancelBooking(id: number): Promise<Booking | null> {
    const booking = await this.db
      .prepare('SELECT * FROM bookings WHERE id = ?')
      .bind(id)
      .first<Booking>();

    if (!booking || booking.status === 'cancelled') return null;

    // อัปเดต booking.status = cancelled
    await this.db
      .prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?")
      .bind(id)
      .run();

    // คืน available_quantity
    await this.db
      .prepare('UPDATE productsPOC SET available_quantity = available_quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(booking.quantity, booking.product_id)
      .run();

    // product_queue: leave cancelled (ลบ record, promote WAITING ถัดไป)
    await this.productQueueService.leaveCancelled(id, booking.product_id);

    return await this.db
      .prepare('SELECT * FROM bookings WHERE id = ?')
      .bind(id)
      .first<Booking>() || null;
  }

  async getBookingById(id: number): Promise<Booking | null> {
    return await this.db
      .prepare('SELECT * FROM bookings WHERE id = ?')
      .bind(id)
      .first<Booking>() || null;
  }

  async getBookingsByUser(userId: number): Promise<any[]> {
    const results = await this.db
      .prepare(`
        SELECT b.*,
          u.first_name, u.last_name, u.email,
          p.product_name, p.price,b.quantity * p.price as sumPrice, p.total_quantity, p.available_quantity
        FROM bookings b
        LEFT JOIN users u ON b.user_id = u.id
        LEFT JOIN productsPOC p ON b.product_id = p.id
        WHERE b.user_id = ?
        ORDER BY b.booking_date DESC
      `)
      .bind(userId)
      .all();
    return results.results || [];
  }

  async getBookingsByProduct(productId: number): Promise<Booking[]> {
    const results = await this.db
      .prepare('SELECT * FROM bookings WHERE product_id = ? ORDER BY booking_date DESC')
      .bind(productId)
      .all<Booking>();
    return results.results || [];
  }

  async getAllBookings(page: number = 1, limit: number = 10): Promise<{ data: any[]; total: number }> {
    const countResult = await this.db
      .prepare('SELECT COUNT(*) as count FROM bookings')
      .first<{ count: number }>();

    const offset = (page - 1) * limit;
    const results = await this.db
      .prepare(`
        SELECT b.*,
          u.first_name, u.last_name, u.email,
          p.product_name, p.price,b.quantity * p.price as sumPrice, p.total_quantity, p.available_quantity
        FROM bookings b
        LEFT JOIN users u ON b.user_id = u.id
        LEFT JOIN productsPOC p ON b.product_id = p.id
        ORDER BY b.booking_date DESC
        LIMIT ? OFFSET ?
      `)
      .bind(limit, offset)
      .all();

    return {
      data: results.results || [],
      total: countResult?.count || 0,
    };
  }
}
