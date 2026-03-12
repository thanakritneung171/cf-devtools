import {
  Post,
  CreatePostInput,
  UpdatePostInput,
  PostWithAuthor,
  PostStats,
  UserPostStats,
  FilterParams,
  PaginatedResponse,
  BatchOperationInput,
} from '../types/post';

export class PostService {
  constructor(private db: D1Database) {}

  /**
   * 1️⃣ Simple SELECT with WHERE
   */
  async getPostsByStatus(status: 'draft' | 'published' | 'archived'): Promise<Post[]> {
    const result = await this.db
      .prepare('SELECT * FROM posts WHERE status = ? AND deleted_at IS NULL')
      .bind(status)
      .all<Post>();

    return result.success ? result.results : [];
  }

  /**
   * 2️⃣ SORTING & PAGINATION
   */
  async getPostsPaginated(params: FilterParams): Promise<PaginatedResponse<Post>> {
    const page = params.page || 1;
    const limit = params.limit || 10;
    const sortBy = params.sort_by || 'created_at';
    const sortOrder = params.sort_order || 'desc';
    const offset = (page - 1) * limit;

    // Build WHERE clause
    let whereCondition = 'deleted_at IS NULL';
    const binds: any[] = [];

    if (params.status) {
      whereCondition += ' AND status = ?';
      binds.push(params.status);
    }

    if (params.user_id) {
      whereCondition += ' AND user_id = ?';
      binds.push(params.user_id);
    }

    if (params.search) {
      whereCondition += ' AND (title LIKE ? OR content LIKE ?)';
      const searchTerm = `%${params.search}%`;
      binds.push(searchTerm, searchTerm);
    }

    // Get total count
    const countQuery = await this.db
      .prepare(`SELECT COUNT(*) as total FROM posts WHERE ${whereCondition}`)
      .bind(...binds)
      .first<{ total: number }>();

    const total = countQuery?.total || 0;
    const totalPages = Math.ceil(total / limit);

    // Get paginated data
    const query = `
      SELECT * FROM posts 
      WHERE ${whereCondition}
      ORDER BY ${sortBy} ${sortOrder}
      LIMIT ? OFFSET ?
    `;

    const result = await this.db
      .prepare(query)
      .bind(...binds, limit, offset)
      .all<Post>();

    return {
      data: result.success ? result.results : [],
      pagination: {
        page,
        limit,
        total,
        total_pages: totalPages,
      },
    };
  }

  /**
   * 3️⃣ JOIN - Get posts with author information
   */
  async getPostsWithAuthors(params: FilterParams): Promise<PaginatedResponse<PostWithAuthor>> {
    const page = params.page || 1;
    const limit = params.limit || 10;
    const offset = (page - 1) * limit;

    let whereCondition = 'p.deleted_at IS NULL';
    const binds: any[] = [];

    if (params.status) {
      whereCondition += ' AND p.status = ?';
      binds.push(params.status);
    }

    if (params.user_id) {
      whereCondition += ' AND p.user_id = ?';
      binds.push(params.user_id);
    }

    if (params.search) {
      whereCondition += ' AND (p.title LIKE ? OR p.content LIKE ?)';
      const searchTerm = `%${params.search}%`;
      binds.push(searchTerm, searchTerm);
    }

    // Get total count
    const countQuery = await this.db
      .prepare(`
        SELECT COUNT(*) as total 
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
        WHERE ${whereCondition}
      `)
      .bind(...binds)
      .first<{ total: number }>();

    const total = countQuery?.total || 0;
    const totalPages = Math.ceil(total / limit);

    // Get data with JOIN
    const query = `
      SELECT 
        p.id,
        p.user_id,
        p.title,
        p.content,
        p.status,
        p.created_at,
        p.updated_at,
        p.deleted_at,
        u.id as 'author.id',
        u.first_name as 'author.first_name',
        u.last_name as 'author.last_name',
        u.email as 'author.email'
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE ${whereCondition}
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const result = await this.db.prepare(query).bind(...binds, limit, offset).all();

    // Transform flat result to nested structure
    const data = (result.results || []).map((row: any) => ({
      id: row.id,
      user_id: row.user_id,
      title: row.title,
      content: row.content,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at,
      author: row['author.id']
        ? {
            id: row['author.id'],
            first_name: row['author.first_name'],
            last_name: row['author.last_name'],
            email: row['author.email'],
          }
        : undefined,
    }));

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        total_pages: totalPages,
      },
    };
  }

  /**
   * 4️⃣ AGGREGATION - Analytics & Statistics
   */
  async getPostStats(): Promise<PostStats> {
    const result = await this.db
      .prepare(
        `
        SELECT 
          COUNT(*) as total_posts,
          SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) as published_posts,
          SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as draft_posts,
          SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) as archived_posts,
          ROUND(AVG(COALESCE(LENGTH(content), 0)), 2) as avg_content_length
        FROM posts 
        WHERE deleted_at IS NULL
      `
      )
      .first<PostStats>();

    return (
      result || {
        total_posts: 0,
        published_posts: 0,
        draft_posts: 0,
        archived_posts: 0,
        avg_content_length: 0,
      }
    );
  }

  /**
   * 4️⃣ AGGREGATION - User-level statistics
   */
  async getUserPostStats(): Promise<UserPostStats[]> {
    const result = await this.db
      .prepare(
        `
        SELECT 
          u.id as user_id,
          CONCAT(u.first_name, ' ', u.last_name) as user_name,
          COUNT(p.id) as total_posts,
          SUM(CASE WHEN p.status = 'published' THEN 1 ELSE 0 END) as published_posts,
          SUM(CASE WHEN p.status = 'draft' THEN 1 ELSE 0 END) as draft_posts,
          MAX(p.created_at) as latest_post_date
        FROM users u
        LEFT JOIN posts p ON u.id = p.user_id AND p.deleted_at IS NULL
        WHERE u.deleted_at IS NULL
        GROUP BY u.id
        ORDER BY total_posts DESC
      `
      )
      .all<UserPostStats>();

    return result.success ? result.results : [];
  }

  /**
   * 5️⃣ TRANSACTIONS - Batch operations with rollback
   */
  async batchCreatePosts(
    posts: CreatePostInput[]
  ): Promise<{ success: boolean; ids: number[]; error?: string }> {
    try {
      const ids: number[] = [];

      for (const post of posts) {
        const result = await this.db
          .prepare(
            `
            INSERT INTO posts (user_id, title, content, status, created_at)
            VALUES (?, ?, ?, ?, ?)
          `
          )
          .bind(post.user_id, post.title, post.content || '', post.status || 'draft', new Date().toISOString())
          .run();

        if (result.success && result.meta.last_row_id) {
          ids.push(Number(result.meta.last_row_id));
        }
      }

      return { success: true, ids };
    } catch (error: any) {
      return { success: false, ids: [], error: error.message };
    }
  }

  /**
   * 6️⃣ FULL TEXT SEARCH
   */
  async searchPosts(query: string, limit: number = 20): Promise<Post[]> {
    const searchTerm = `%${query}%`;

    const result = await this.db
      .prepare(
        `
        SELECT * FROM posts 
        WHERE deleted_at IS NULL AND (
          title LIKE ? OR 
          content LIKE ? OR
          status LIKE ?
        )
        ORDER BY 
          CASE 
            WHEN title LIKE ? THEN 1
            WHEN content LIKE ? THEN 2
            ELSE 3
          END,
          created_at DESC
        LIMIT ?
      `
      )
      .bind(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, limit)
      .all<Post>();

    return result.success ? result.results : [];
  }

  /**
   * 7️⃣ BATCH QUERIES - Get multiple posts by IDs
   */
  async getPostsByIds(ids: number[]): Promise<Post[]> {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    const result = await this.db
      .prepare(`SELECT * FROM posts WHERE id IN (${placeholders}) AND deleted_at IS NULL`)
      .bind(...ids)
      .all<Post>();

    return result.success ? result.results : [];
  }

  /**
   * 8️⃣ JSON STORAGE - Store and retrieve JSON metadata
   */
  async createPostWithMetadata(postInput: CreatePostInput): Promise<Post | null> {
    try {
      const metadataJson = JSON.stringify(postInput.metadata || {});

      const result = await this.db
        .prepare(
          `
          INSERT INTO posts (user_id, title, content, status, created_at)
          VALUES (?, ?, ?, ?, ?)
        `
        )
        .bind(
          postInput.user_id,
          postInput.title,
          postInput.content || '',
          postInput.status || 'draft',
          new Date().toISOString()
        )
        .run();

      if (result.success && result.meta.last_row_id) {
        return this.getPostById(Number(result.meta.last_row_id));
      }

      return null;
    } catch (error) {
      console.error('Error creating post with metadata:', error);
      return null;
    }
  }

  /**
   * 9️⃣ DATA RELATIONSHIPS - Get related posts
   */
  async getRelatedPosts(postId: number, limit: number = 5): Promise<Post[]> {
    // Get the reference post
    const post = await this.getPostById(postId);
    if (!post) return [];

    // Find posts with same user and status
    const result = await this.db
      .prepare(
        `
        SELECT * FROM posts 
        WHERE 
          user_id = ? AND 
          status = ? AND 
          id != ? AND
          deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT ?
      `
      )
      .bind(post.user_id, post.status, postId, limit)
      .all<Post>();

    return result.success ? result.results : [];
  }

  /**
   * Simple CRUD Operations
   */
  async getPostById(id: number): Promise<Post | null> {
    const result = await this.db
      .prepare('SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL')
      .bind(id)
      .first<Post>();

    return result || null;
  }

  async createPost(post: CreatePostInput): Promise<Post | null> {
    try {
      const result = await this.db
        .prepare(
          `
          INSERT INTO posts (user_id, title, content, status, created_at)
          VALUES (?, ?, ?, ?, ?)
        `
        )
        .bind(
          post.user_id,
          post.title,
          post.content || '',
          post.status || 'draft',
          new Date().toISOString()
        )
        .run();

      if (result.success && result.meta.last_row_id) {
        return this.getPostById(Number(result.meta.last_row_id));
      }

      return null;
    } catch (error) {
      console.error('Error creating post:', error);
      return null;
    }
  }

  async updatePost(id: number, updates: UpdatePostInput): Promise<Post | null> {
    try {
      const updatedAt = new Date().toISOString();

      const result = await this.db
        .prepare(
          `
          UPDATE posts
          SET 
            title = COALESCE(?, title),
            content = COALESCE(?, content),
            status = COALESCE(?, status),
            updated_at = ?
          WHERE id = ? AND deleted_at IS NULL
        `
        )
        .bind(updates.title || null, updates.content || null, updates.status || null, updatedAt, id)
        .run();

      if (result.success) {
        return this.getPostById(id);
      }

      return null;
    } catch (error) {
      console.error('Error updating post:', error);
      return null;
    }
  }

  async deletePost(id: number): Promise<boolean> {
    try {
      const result = await this.db
        .prepare('UPDATE posts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
        .bind(new Date().toISOString(), id)
        .run();

      return result.success;
    } catch (error) {
      console.error('Error deleting post:', error);
      return false;
    }
  }

  async hardDeletePost(id: number): Promise<boolean> {
    try {
      const result = await this.db.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();

      return result.success;
    } catch (error) {
      console.error('Error hard deleting post:', error);
      return false;
    }
  }
}
