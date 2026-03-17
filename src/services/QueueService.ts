import { BookingQueue } from '../types/productPOC';

interface Env {
  DB: D1Database;
  PRODUCT_QUEUE: DurableObjectNamespace;
}

export class QueueService {
  private db: D1Database;

  constructor(env: Env) {
    this.db = env.DB;
  }

  async addToQueue(userId: number, productId: number, quantity: number): Promise<BookingQueue> {
    // Get next queue number for this product
    const last = await this.db
      .prepare("SELECT MAX(queue_number) as max_num FROM bookingQueue WHERE product_id = ? AND status = 'waiting'")
      .bind(productId)
      .first<{ max_num: number | null }>();

    const queueNumber = (last?.max_num || 0) + 1;

    const result = await this.db
      .prepare(
        `INSERT INTO bookingQueue (user_id, product_id, quantity, queue_number, status)
         VALUES (?, ?, ?, ?, 'waiting')`
      )
      .bind(userId, productId, quantity, queueNumber)
      .run();

    return (await this.db
      .prepare('SELECT * FROM bookingQueue WHERE id = ?')
      .bind(result.meta.last_row_id)
      .first<BookingQueue>())!;
  }

  async processQueue(productId: number): Promise<void> {
    // Get current available quantity
    const product = await this.db
      .prepare('SELECT * FROM productsPOC WHERE id = ?')
      .bind(productId)
      .first<any>();

    if (!product || product.available_quantity <= 0) return;

    // Get waiting queue items ordered by queue_number
    const queueItems = await this.db
      .prepare("SELECT * FROM bookingQueue WHERE product_id = ? AND status = 'waiting' ORDER BY queue_number ASC")
      .bind(productId)
      .all<BookingQueue>();

    let availableQty = product.available_quantity;

    for (const item of queueItems.results || []) {
      if (availableQty < item.quantity) break;

      // Create booking
      await this.db
        .prepare(
          `INSERT INTO bookings (user_id, product_id, quantity, status) VALUES (?, ?, ?, 'booked')`
        )
        .bind(item.user_id, item.product_id, item.quantity)
        .run();

      // Reduce stock
      availableQty -= item.quantity;

      // Mark queue item as completed
      await this.db
        .prepare("UPDATE bookingQueue SET status = 'completed' WHERE id = ?")
        .bind(item.id)
        .run();
    }

    // Update product available_quantity
    await this.db
      .prepare('UPDATE productsPOC SET available_quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(availableQty, productId)
      .run();
  }

  async getQueueByProduct(productId: number): Promise<BookingQueue[]> {
    const results = await this.db
      .prepare("SELECT * FROM bookingQueue WHERE product_id = ? AND status = 'waiting' ORDER BY queue_number ASC")
      .bind(productId)
      .all<BookingQueue>();
    return results.results || [];
  }

  async cancelQueue(id: number): Promise<BookingQueue | null> {
    const item = await this.db
      .prepare('SELECT * FROM bookingQueue WHERE id = ?')
      .bind(id)
      .first<BookingQueue>();

    if (!item || item.status !== 'waiting') return null;

    await this.db
      .prepare("UPDATE bookingQueue SET status = 'cancelled' WHERE id = ?")
      .bind(id)
      .run();

    return await this.db
      .prepare('SELECT * FROM bookingQueue WHERE id = ?')
      .bind(id)
      .first<BookingQueue>() || null;
  }
}
