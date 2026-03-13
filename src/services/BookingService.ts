import { Booking, CreateBookingInput } from '../types/productPOC';
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
