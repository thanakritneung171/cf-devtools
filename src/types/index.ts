export interface User {
  id: number;
  email: string;
  password_hash: string;
  first_name: string;
  last_name: string;
  address?: string;
  phone?: string;
  date_of_birth?: string;
  status: string;
  role: string;
  avatar_url?: string;
  last_login_at?: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

export interface CreateUserInput {
  email: string;
  password_hash: string;
  first_name: string;
  last_name: string;
  address?: string;
  phone?: string;
  date_of_birth?: string;
  status?: string;
  role?: string;
  avatar_url?: string;
}

export interface CreateUserWithAvatarInput {
  email: string;
  password_hash: string;
  first_name: string;
  last_name: string;
  address?: string;
  phone?: string;
  date_of_birth?: string;
  status?: string;
  role?: string;
  file?: File;
}

export interface UpdateUserInput {
  first_name?: string;
  last_name?: string;
  address?: string;
  phone?: string;
  date_of_birth?: string;
  status?: string;
  role?: string;
  avatar_url?: string;
  last_login_at?: string;
}

export interface PaginationParams {
  page: number;
  limit: number;
}

export interface FilterParams {
  status?: string;
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

export interface UserResponse {
  user: User;
  source: 'cache' | 'database';
  cached_at?: string;
}

export interface PaginatedUserResponse {
  data: (User & { source: 'cache' | 'database' })[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}
