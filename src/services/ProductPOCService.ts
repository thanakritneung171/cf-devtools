import { ProductPOC, CreateProductPOCInput, UpdateProductPOCInput } from '../types/productPOC';

interface Env {
  DB: D1Database;
  R2_DOMAIN?: string;
}

export class ProductPOCService {
  private db: D1Database;
  private r2Domain: string;

  constructor(env: Env) {
    this.db = env.DB;
    this.r2Domain = env.R2_DOMAIN || 'https://pub-5996ee0506414893a70d525a21960eba.r2.dev';
  }

  private async attachImageUrl(product: ProductPOC): Promise<ProductPOC> {
    if (product.image_id) {
      const file = await this.db
        .prepare('SELECT file_path FROM files WHERE id = ?')
        .bind(product.image_id)
        .first<{ file_path: string }>();
      if (file) {
        product.image_url = `${this.r2Domain}/${file.file_path}`;
      }
    }
    return product;
  }

  async create(data: CreateProductPOCInput): Promise<ProductPOC> {
    const result = await this.db
      .prepare(
        `INSERT INTO productsPOC (user_id, product_name, description, price, total_quantity, available_quantity, image_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(data.user_id, data.product_name, data.description || null, data.price, data.total_quantity, data.available_quantity, data.image_id || null)
      .run();

    return (await this.getById(result.meta.last_row_id))!;
  }

  async getById(id: number): Promise<ProductPOC | null> {
    const product = await this.db
      .prepare('SELECT * FROM productsPOC WHERE id = ?')
      .bind(id)
      .first<ProductPOC>();
    if (!product) return null;
    return this.attachImageUrl(product);
  }

  async getAll(page: number = 1, limit: number = 10, search?: string): Promise<{ data: ProductPOC[]; total: number }> {
    let query = 'SELECT p.*, f.file_path FROM productsPOC p LEFT JOIN files f ON p.image_id = f.id';
    let countQuery = 'SELECT COUNT(*) as count FROM productsPOC p';
    const params: any[] = [];

    if (search) {
      const where = ' WHERE p.product_name LIKE ?';
      query += where;
      countQuery += where;
      params.push(`%${search}%`);
    }

    const countResult = await this.db
      .prepare(countQuery)
      .bind(...params)
      .first<{ count: number }>();

    const offset = (page - 1) * limit;
    query += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';

    const results = await this.db
      .prepare(query)
      .bind(...params, limit, offset)
      .all<ProductPOC & { file_path?: string }>();

    const data = (results.results || []).map(p => {
      const { file_path, ...product } = p;
      if (file_path) {
        product.image_url = `${this.r2Domain}/${file_path}`;
      }
      return product;
    });

    return {
      data,
      total: countResult?.count || 0,
    };
  }

  async update(id: number, data: UpdateProductPOCInput): Promise<ProductPOC | null> {
    const existing = await this.getById(id);
    if (!existing) return null;

    const updates: string[] = [];
    const values: any[] = [];

    if (data.product_name !== undefined) { updates.push('product_name = ?'); values.push(data.product_name); }
    if (data.description !== undefined) { updates.push('description = ?'); values.push(data.description); }
    if (data.price !== undefined) { updates.push('price = ?'); values.push(data.price); }
    if (data.total_quantity !== undefined) { updates.push('total_quantity = ?'); values.push(data.total_quantity); }
    if (data.available_quantity !== undefined) { updates.push('available_quantity = ?'); values.push(data.available_quantity); }
    if (data.image_id !== undefined) { updates.push('image_id = ?'); values.push(data.image_id); }

    if (updates.length === 0) return existing;

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    await this.db
      .prepare(`UPDATE productsPOC SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();

    return this.getById(id);
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM productsPOC WHERE id = ?')
      .bind(id)
      .run();
    return result.meta.changes > 0;
  }
}
