import { BookingQueue } from '../types/productPOC';

interface Env {
  DB: D1Database;
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

  async getAllQueues(page: number = 1, limit: number = 10, status?: string): Promise<{ data: BookingQueue[]; total: number }> {
    let countSql = 'SELECT COUNT(*) as count FROM bookingQueue';
    let dataSql = 'SELECT * FROM bookingQueue';
    const binds: any[] = [];

    if (status) {
      countSql += ' WHERE status = ?';
      dataSql += ' WHERE status = ?';
      binds.push(status);
    }

    dataSql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';

    const countResult = await this.db
      .prepare(countSql)
      .bind(...binds)
      .first<{ count: number }>();

    const offset = (page - 1) * limit;
    const results = await this.db
      .prepare(dataSql)
      .bind(...binds, limit, offset)
      .all<BookingQueue>();

    return {
      data: results.results || [],
      total: countResult?.count || 0,
    };
  }

  async getQueueById(id: number): Promise<BookingQueue | null> {
    return await this.db
      .prepare('SELECT * FROM bookingQueue WHERE id = ?')
      .bind(id)
      .first<BookingQueue>() || null;
  }

  async getQueueByProduct(productId: number): Promise<BookingQueue[]> {
    const results = await this.db
      .prepare("SELECT * FROM bookingQueue WHERE product_id = ? AND status = 'waiting' ORDER BY queue_number ASC")
      .bind(productId)
      .all<BookingQueue>();
    return results.results || [];
  }

  async clearQueueByProduct(productId: number): Promise<number> {
    const result = await this.db
      .prepare("UPDATE bookingQueue SET status = 'cancelled' WHERE product_id = ? AND status = 'waiting'")
      .bind(productId)
      .run();
    return result.meta.changes ?? 0;
  }

  async getQueueCount(productId: number): Promise<number> {
    const result = await this.db
      .prepare("SELECT COUNT(*) as count FROM bookingQueue WHERE product_id = ? AND status = 'waiting'")
      .bind(productId)
      .first<{ count: number }>();
    return result?.count || 0;
  }

  async getQueuePosition(queueId: number): Promise<{ position: number; total: number } | null> {
    const item = await this.db
      .prepare('SELECT * FROM bookingQueue WHERE id = ?')
      .bind(queueId)
      .first<BookingQueue>();
    if (!item || item.status !== 'waiting') return null;

    const ahead = await this.db
      .prepare("SELECT COUNT(*) as count FROM bookingQueue WHERE product_id = ? AND status = 'waiting' AND queue_number < ?")
      .bind(item.product_id, item.queue_number)
      .first<{ count: number }>();

    const total = await this.getQueueCount(item.product_id);
    return { position: (ahead?.count || 0) + 1, total };
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
