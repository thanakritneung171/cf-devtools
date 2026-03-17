import { Booking, CreateBookingInput, CountdownStatus } from '../types/productPOC';
import { QueueService } from './QueueService';

interface Env {
  DB: D1Database;
}

export class BookingService {
  private db: D1Database;
  private queueService: QueueService;

  constructor(env: Env) {
    this.db = env.DB;
    this.queueService = new QueueService(env);
  }

  async createBooking(data: CreateBookingInput): Promise<{ booking?: Booking; queue?: any; message: string }> {
    // Check product availability
    const product = await this.db
      .prepare('SELECT * FROM productsPOC WHERE id = ?')
      .bind(data.product_id)
      .first<any>();

    if (!product) {
      throw new Error('ไม่พบสินค้า');
    }

    if (product.available_quantity >= data.quantity) {
      // Enough stock - create booking and reduce available_quantity
      const result = await this.db
        .prepare(
          `INSERT INTO bookings (user_id, product_id, quantity, status) VALUES (?, ?, ?, 'booked')`
        )
        .bind(data.user_id, data.product_id, data.quantity)
        .run();

      await this.db
        .prepare('UPDATE productsPOC SET available_quantity = available_quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(data.quantity, data.product_id)
        .run();

      const booking = await this.db
        .prepare('SELECT * FROM bookings WHERE id = ?')
        .bind(result.meta.last_row_id)
        .first<Booking>();

      return { booking: booking!, message: 'จองสินค้าสำเร็จ' };
    } else {
      // Not enough stock - add to queue
      const queue = await this.queueService.addToQueue(data.user_id, data.product_id, data.quantity);
      return { queue, message: 'สินค้าไม่เพียงพอ เข้าคิวรอจองอัตโนมัติ' };
    }
  }

  async cancelBooking(id: number): Promise<Booking | null> {
    const booking = await this.db
      .prepare('SELECT * FROM bookings WHERE id = ?')
      .bind(id)
      .first<Booking>();

    if (!booking || booking.status === 'cancelled') return null;

    // Cancel booking
    await this.db
      .prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?")
      .bind(id)
      .run();

    // Return stock
    await this.db
      .prepare('UPDATE productsPOC SET available_quantity = available_quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(booking.quantity, booking.product_id)
      .run();

    // Process queue for this product
    await this.queueService.processQueue(booking.product_id);

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

  async completeBooking(id: number): Promise<Booking | null> {
    const booking = await this.db
      .prepare('SELECT * FROM bookings WHERE id = ?')
      .bind(id)
      .first<Booking>();

    if (!booking || booking.status !== 'booked') return null;

    // Mark as completed
    await this.db
      .prepare("UPDATE bookings SET status = 'completed' WHERE id = ?")
      .bind(id)
      .run();

    // Return stock
    await this.db
      .prepare('UPDATE productsPOC SET available_quantity = available_quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(booking.quantity, booking.product_id)
      .run();

    // Process waiting queue
    await this.queueService.processQueue(booking.product_id);

    return await this.db
      .prepare('SELECT * FROM bookings WHERE id = ?')
      .bind(id)
      .first<Booking>() || null;
  }

  async startCountdown(id: number, minSeconds: number = 10, maxSeconds: number = 120): Promise<CountdownStatus | null> {
    const booking = await this.db
      .prepare('SELECT * FROM bookings WHERE id = ?')
      .bind(id)
      .first<Booking>();

    if (!booking || booking.status !== 'booked') return null;

    // Random countdown between min and max seconds
    const countdownSeconds = Math.floor(Math.random() * (maxSeconds - minSeconds + 1)) + minSeconds;
    const now = new Date();
    const estimatedCompleteAt = new Date(now.getTime() + countdownSeconds * 1000).toISOString();

    await this.db
      .prepare('UPDATE bookings SET countdown_seconds = ?, estimated_complete_at = ? WHERE id = ?')
      .bind(countdownSeconds, estimatedCompleteAt, id)
      .run();

    return {
      booking_id: id,
      status: 'counting_down',
      countdown_seconds: countdownSeconds,
      estimated_complete_at: estimatedCompleteAt,
      remaining_seconds: countdownSeconds,
      is_completed: false,
    };
  }

  async checkCountdown(id: number): Promise<CountdownStatus | null> {
    const booking = await this.db
      .prepare('SELECT * FROM bookings WHERE id = ?')
      .bind(id)
      .first<Booking>();

    if (!booking) return null;

    // ถ้ายังไม่ได้เริ่ม countdown
    if (!booking.estimated_complete_at || !booking.countdown_seconds) {
      return {
        booking_id: id,
        status: booking.status,
        countdown_seconds: 0,
        estimated_complete_at: '',
        remaining_seconds: 0,
        is_completed: booking.status === 'completed',
      };
    }

    const now = new Date();
    const estimatedTime = new Date(booking.estimated_complete_at);
    const remainingMs = estimatedTime.getTime() - now.getTime();
    const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));

    // ถ้าหมดเวลาแล้ว และยังเป็น booked → auto-complete
    if (remainingSeconds <= 0 && booking.status === 'booked') {
      const completed = await this.completeBooking(id);
      return {
        booking_id: id,
        status: 'completed',
        countdown_seconds: booking.countdown_seconds,
        estimated_complete_at: booking.estimated_complete_at,
        remaining_seconds: 0,
        is_completed: true,
      };
    }

    return {
      booking_id: id,
      status: remainingSeconds > 0 ? 'counting_down' : booking.status,
      countdown_seconds: booking.countdown_seconds,
      estimated_complete_at: booking.estimated_complete_at,
      remaining_seconds: remainingSeconds,
      is_completed: booking.status === 'completed',
    };
  }

  async createBookingFromQueue(queueId: number): Promise<{ booking: Booking; queue: any; message: string } | null> {
    // ดึง queue item
    const queueItem = await this.queueService.getQueueById(queueId);
    if (!queueItem || queueItem.status !== 'waiting') return null;

    // เช็ค stock
    const product = await this.db
      .prepare('SELECT * FROM productsPOC WHERE id = ?')
      .bind(queueItem.product_id)
      .first<any>();

    if (!product) throw new Error('ไม่พบสินค้า');

    if (product.available_quantity < queueItem.quantity) {
      throw new Error(`สินค้าไม่เพียงพอ (เหลือ ${product.available_quantity} ต้องการ ${queueItem.quantity})`);
    }

    // สร้าง booking
    const result = await this.db
      .prepare(`INSERT INTO bookings (user_id, product_id, quantity, status) VALUES (?, ?, ?, 'booked')`)
      .bind(queueItem.user_id, queueItem.product_id, queueItem.quantity)
      .run();

    // ลด stock
    await this.db
      .prepare('UPDATE productsPOC SET available_quantity = available_quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(queueItem.quantity, queueItem.product_id)
      .run();

    // อัปเดต queue เป็น completed
    await this.db
      .prepare("UPDATE bookingQueue SET status = 'completed' WHERE id = ?")
      .bind(queueId)
      .run();

    const booking = await this.db
      .prepare('SELECT * FROM bookings WHERE id = ?')
      .bind(result.meta.last_row_id)
      .first<Booking>();

    const updatedQueue = await this.queueService.getQueueById(queueId);

    return {
      booking: booking!,
      queue: updatedQueue,
      message: `สร้างการจองจากคิว #${queueId} สำเร็จ`,
    };
  }

  async getBookingsByUser(userId: number): Promise<Booking[]> {
    const results = await this.db
      .prepare('SELECT * FROM bookings WHERE user_id = ? ORDER BY booking_date DESC')
      .bind(userId)
      .all<Booking>();
    return results.results || [];
  }

  async getBookingsByProduct(productId: number): Promise<Booking[]> {
    const results = await this.db
      .prepare('SELECT * FROM bookings WHERE product_id = ? ORDER BY booking_date DESC')
      .bind(productId)
      .all<Booking>();
    return results.results || [];
  }

  async getAllBookings(page: number = 1, limit: number = 10): Promise<{ data: Booking[]; total: number }> {
    const countResult = await this.db
      .prepare('SELECT COUNT(*) as count FROM bookings')
      .first<{ count: number }>();

    const offset = (page - 1) * limit;
    const results = await this.db
      .prepare('SELECT * FROM bookings ORDER BY booking_date DESC LIMIT ? OFFSET ?')
      .bind(limit, offset)
      .all<Booking>();

    return {
      data: results.results || [],
      total: countResult?.count || 0,
    };
  }
}
