export interface Post {
  id: number;
  user_id: number;
  title: string;
  content?: string;
  status: 'draft' | 'published' | 'archived';
  created_at: string;
  updated_at?: string;
  deleted_at?: string;
  tags?: string[];
  metadata?: Record<string, any>;
}

export interface CreatePostInput {
  user_id: number;
  title: string;
  content?: string;
  status?: 'draft' | 'published' | 'archived';
  tags?: string[];
  metadata?: Record<string, any>;
}

export interface UpdatePostInput {
  title?: string;
  content?: string;
  status?: 'draft' | 'published' | 'archived';
  tags?: string[];
  metadata?: Record<string, any>;
}

export interface PostWithAuthor extends Post {
  author?: {
    id: number;
    first_name: string;
    last_name: string;
    email: string;
  };
}

export interface PostStats {
  total_posts: number;
  published_posts: number;
  draft_posts: number;
  archived_posts: number;
  avg_content_length: number;
}

export interface UserPostStats {
  user_id: number;
  user_name: string;
  total_posts: number;
  published_posts: number;
  draft_posts: number;
  latest_post_date: string;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
  sort_by?: 'created_at' | 'updated_at' | 'title';
  sort_order?: 'asc' | 'desc';
}

export interface FilterParams extends PaginationParams {
  status?: 'draft' | 'published' | 'archived';
  user_id?: number;
  search?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}

export interface BatchOperationInput {
  operations: Array<{
    type: 'insert' | 'update' | 'delete';
    data: CreatePostInput | (UpdatePostInput & { id: number });
  }>;
}
