import { User, CreateUserInput, CreateUserWithAvatarInput, UpdateUserInput, PaginationParams, FilterParams, PaginatedResponse, UserResponse, PaginatedUserResponse } from '../types';

interface Env {
  DB: D1Database;
  USERS_CACHE: KVNamespace;
  MY_BUCKET?: R2Bucket;
}

export class UserService {
  private db: D1Database;
  private cache: KVNamespace;
  private bucket?: R2Bucket;
  private cacheExpiry = 60; // 1 hour

  constructor(env: Env) {
    this.db = env.DB;
    this.cache = env.USERS_CACHE;
    this.bucket = env.MY_BUCKET;
  }

  private getCacheKey(key: string): string {
    return `user:${key}`;
  }

  async createUser(data: CreateUserInput): Promise<User> {
    const result = await this.db
      .prepare(
        `INSERT INTO users (email, password_hash, first_name, last_name, address, phone, date_of_birth, status, avatar_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        data.email,
        data.password_hash,
        data.first_name,
        data.last_name,
        data.address || null,
        data.phone || null,
        data.date_of_birth || null,
        data.status || 'active',
        data.avatar_url || null
      )
      .run();

    const user = await this.getUserById(result.meta.last_row_id);
    if (user) {
      await this.cache.put(this.getCacheKey(user.id.toString()), JSON.stringify(user), { expirationTtl: this.cacheExpiry });
    }
    return user!;
  }

  async createUserWithAvatar(data: CreateUserWithAvatarInput, r2Domain?: string): Promise<User> {
    // Create user first
    const result = await this.db
      .prepare(
        `INSERT INTO users (email, password_hash, first_name, last_name, address, phone, date_of_birth, status, avatar_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        data.email,
        data.password_hash,
        data.first_name,
        data.last_name,
        data.address || null,
        data.phone || null,
        data.date_of_birth || null,
        data.status || 'active',
        null // avatar_url will be updated if file provided
      )
      .run();

    const userId = result.meta.last_row_id;
    let user = await this.getUserById(userId);

    // Upload avatar if file provided
    if (data.file && this.bucket && user) {
      const timestamp = Date.now();
      const fileExtension = data.file.type.split('/')[1] || 'jpg';
      const filename = `users/${userId}/avatar-${timestamp}.${fileExtension}`;

      const arrayBuffer = await data.file.arrayBuffer();
      await this.bucket.put(filename, arrayBuffer, {
        httpMetadata: {
          contentType: data.file.type,
        },
      });

      // Generate avatar URL
      const avatarUrl = `${r2Domain || 'https://cdn.example.com'}/${filename}`;

      // Update user with avatar URL
      await this.db
        .prepare(`UPDATE users SET avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(avatarUrl, userId)
        .run();

      // Invalidate cache and get updated user
      await this.cache.delete(this.getCacheKey(userId.toString()));
      user = await this.getUserById(userId);
    }

    return user!;
  }

  async getUserById(id: number): Promise<User | null> {
    // Try cache first
    const cached = await this.cache.get(this.getCacheKey(id.toString()));
    if (cached) {
      return JSON.parse(cached);
    }

    const result = await this.db
      .prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL')
      .bind(id)
      .first<User>();

    if (result) {
      await this.cache.put(this.getCacheKey(id.toString()), JSON.stringify(result), { expirationTtl: this.cacheExpiry });
    }
    return result || null;
  }

  async getUserByIdWithSource(id: number): Promise<{ user: User; source: 'cache' | 'database' } | null> {
    // Try cache first
    const cached = await this.cache.get(this.getCacheKey(id.toString()));
    if (cached) {
      return {
        user: JSON.parse(cached),
        source: 'cache',
      };
    }

    const result = await this.db
      .prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL')
      .bind(id)
      .first<User>();

    if (result) {
      await this.cache.put(this.getCacheKey(id.toString()), JSON.stringify(result), { expirationTtl: this.cacheExpiry });
      return {
        user: result,
        source: 'database',
      };
    }
    return null;
  }

  async getAllUsers(
    pagination: PaginationParams,
    filters: FilterParams
  ): Promise<PaginatedUserResponse> {
    let query = 'SELECT * FROM users WHERE deleted_at IS NULL';
    const params: any[] = [];

    if (filters.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }

    if (filters.search) {
      query += ' AND (first_name LIKE ? OR last_name LIKE ? OR email LIKE ?)';
      const searchTerm = `%${filters.search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }

    // Get total count
    const countResult = await this.db
      .prepare(query.replace('SELECT *', 'SELECT COUNT(*) as count'))
      .bind(...params)
      .first<{ count: number }>();

    const total = countResult?.count || 0;

    // Get paginated data
    const offset = (pagination.page - 1) * pagination.limit;
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(pagination.limit, offset);

    const users = await this.db
      .prepare(query)
      .bind(...params)
      .all<User>();

    // Add source info (getAllUsers always from database due to filtering)
    const usersWithSource = (users.results || []).map(user => ({
      ...user,
      source: 'database' as const,
    }));

    return {
      data: usersWithSource,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        total_pages: Math.ceil(total / pagination.limit),
      },
    };
  }

  async updateUser(id: number, data: UpdateUserInput): Promise<User | null> {
    const user = await this.getUserById(id);
    if (!user) return null;

    const updates: string[] = [];
    const values: any[] = [];

    if (data.first_name !== undefined) {
      updates.push('first_name = ?');
      values.push(data.first_name);
    }
    if (data.last_name !== undefined) {
      updates.push('last_name = ?');
      values.push(data.last_name);
    }
    if (data.address !== undefined) {
      updates.push('address = ?');
      values.push(data.address);
    }
    if (data.phone !== undefined) {
      updates.push('phone = ?');
      values.push(data.phone);
    }
    if (data.date_of_birth !== undefined) {
      updates.push('date_of_birth = ?');
      values.push(data.date_of_birth);
    }
    if (data.status !== undefined) {
      updates.push('status = ?');
      values.push(data.status);
    }
    if (data.avatar_url !== undefined) {
      updates.push('avatar_url = ?');
      values.push(data.avatar_url);
    }
    if (data.last_login_at !== undefined) {
      updates.push('last_login_at = ?');
      values.push(data.last_login_at);
    }

    if (updates.length === 0) return user;

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    await this.db
      .prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();

    // Invalidate cache
    await this.cache.delete(this.getCacheKey(id.toString()));

    return this.getUserById(id);
  }

  async updateUserAvatarUrl(id: number, avatarUrl: string): Promise<User | null> {
    const user = await this.getUserById(id);
    if (!user) return null;

    await this.db
      .prepare(`UPDATE users SET avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(avatarUrl, id)
      .run();

    // Invalidate cache
    await this.cache.delete(this.getCacheKey(id.toString()));

    return this.getUserById(id);
  }

  async deleteUser(id: number): Promise<boolean> {
    await this.db
      .prepare('UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(id)
      .run();

    // Invalidate cache
    await this.cache.delete(this.getCacheKey(id.toString()));
    return true;
  }
}
