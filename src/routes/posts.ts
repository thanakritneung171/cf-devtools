import { PostService } from '../services/PostService';
import { CreatePostInput, UpdatePostInput, FilterParams } from '../types/post';

interface Env {
  DB: D1Database;
}

export async function handlePostRoutes(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  const postService = new PostService(env.DB);

  /**
   * GET /api/posts - Get all posts with pagination & filtering
   * Query params: page, limit, status, user_id, search, sort_by, sort_order
   */
  if (url.pathname === '/api/posts' && method === 'GET') {
    const params: FilterParams = {
      page: parseInt(url.searchParams.get('page') || '1'),
      limit: parseInt(url.searchParams.get('limit') || '10'),
      status: url.searchParams.get('status') as any,
      user_id: url.searchParams.get('user_id') ? parseInt(url.searchParams.get('user_id')!) : undefined,
      search: url.searchParams.get('search') || undefined,
      sort_by: url.searchParams.get('sort_by') as any,
      sort_order: url.searchParams.get('sort_order') as any,
    };

    const data = await postService.getPostsPaginated(params);
    return Response.json(data);
  }

  /**
   * GET /api/posts/with-authors - Get posts with author information (JOIN)
   * Query params: page, limit, status, user_id, search
   */
  if (url.pathname === '/api/posts/with-authors' && method === 'GET') {
    const params: FilterParams = {
      page: parseInt(url.searchParams.get('page') || '1'),
      limit: parseInt(url.searchParams.get('limit') || '10'),
      status: url.searchParams.get('status') as any,
      user_id: url.searchParams.get('user_id') ? parseInt(url.searchParams.get('user_id')!) : undefined,
      search: url.searchParams.get('search') || undefined,
    };

    const data = await postService.getPostsWithAuthors(params);
    return Response.json(data);
  }

  /**
   * GET /api/posts/by-status/:status - Get posts filtered by status
   */
  if (url.pathname.match(/^\/api\/posts\/by-status\/(draft|published|archived)$/)) {
    const status = url.pathname.split('/').pop() as 'draft' | 'published' | 'archived';
    const data = await postService.getPostsByStatus(status);
    return Response.json({ data });
  }

  /**
   * GET /api/posts/stats - Get post statistics & aggregation
   */
  if (url.pathname === '/api/posts/stats' && method === 'GET') {
    const stats = await postService.getPostStats();
    return Response.json({ stats });
  }

  /**
   * GET /api/posts/user-stats - Get user-level post statistics
   */
  if (url.pathname === '/api/posts/user-stats' && method === 'GET') {
    const stats = await postService.getUserPostStats();
    return Response.json({ data: stats });
  }

  /**
   * GET /api/posts/search - Full text search
   * Query params: q (search query), limit
   */
  if (url.pathname === '/api/posts/search' && method === 'GET') {
    const query = url.searchParams.get('q') || '';
    const limit = parseInt(url.searchParams.get('limit') || '20');

    if (!query) {
      return Response.json({ error: 'Search query is required' }, { status: 400 });
    }

    const data = await postService.searchPosts(query, limit);
    return Response.json({ data, query });
  }

  /**
   * POST /api/posts/batch - Create multiple posts (Batch Queries)
   * Body: { posts: CreatePostInput[] }
   */
  if (url.pathname === '/api/posts/batch' && method === 'POST') {
    const body = (await request.json()) as { posts: CreatePostInput[] };

    if (!body.posts || !Array.isArray(body.posts)) {
      return Response.json({ error: 'posts array is required' }, { status: 400 });
    }

    const result = await postService.batchCreatePosts(body.posts);
    return Response.json(result);
  }

  /**
   * POST /api/posts/batch-get - Get multiple posts by IDs
   * Body: { ids: number[] }
   */
  if (url.pathname === '/api/posts/batch-get' && method === 'POST') {
    const body = (await request.json()) as { ids: number[] };

    if (!body.ids || !Array.isArray(body.ids)) {
      return Response.json({ error: 'ids array is required' }, { status: 400 });
    }

    const data = await postService.getPostsByIds(body.ids);
    return Response.json({ data });
  }

  /**
   * GET /api/posts/:id - Get single post
   */
  if (url.pathname.match(/^\/api\/posts\/\d+$/) && method === 'GET' && !url.pathname.includes('/with-') && !url.pathname.includes('/by-') && !url.pathname.includes('/related')) {
    const id = parseInt(url.pathname.split('/').pop()!);
    const post = await postService.getPostById(id);

    if (!post) {
      return Response.json({ error: 'Post not found' }, { status: 404 });
    }

    return Response.json({ data: post });
  }

  /**
   * GET /api/posts/:id/related - Get related posts (Data Relationships)
   */
  if (url.pathname.match(/^\/api\/posts\/\d+\/related$/)) {
    const id = parseInt(url.pathname.split('/')[3]);
    const limit = parseInt(url.searchParams.get('limit') || '5');

    const data = await postService.getRelatedPosts(id, limit);
    return Response.json({ data, post_id: id });
  }

  /**
   * POST /api/posts - Create new post
   * Body: CreatePostInput
   */
  if (url.pathname === '/api/posts' && method === 'POST') {
    const body = (await request.json()) as CreatePostInput;

    if (!body.user_id || !body.title) {
      return Response.json({ error: 'user_id and title are required' }, { status: 400 });
    }

    const post = await postService.createPost(body);

    if (!post) {
      return Response.json({ error: 'Failed to create post' }, { status: 500 });
    }

    return Response.json({ data: post }, { status: 201 });
  }

  /**
   * PUT /api/posts/:id - Update post
   */
  if (url.pathname.match(/^\/api\/posts\/\d+$/) && method === 'PUT') {
    const id = parseInt(url.pathname.split('/').pop()!);
    const updates = (await request.json()) as UpdatePostInput;

    const post = await postService.updatePost(id, updates);

    if (!post) {
      return Response.json({ error: 'Post not found' }, { status: 404 });
    }

    return Response.json({ data: post });
  }

  /**
   * DELETE /api/posts/:id - Soft delete post
   */
  if (url.pathname.match(/^\/api\/posts\/\d+$/) && method === 'DELETE') {
    const id = parseInt(url.pathname.split('/').pop()!);

    const success = await postService.deletePost(id);

    if (!success) {
      return Response.json({ error: 'Post not found' }, { status: 404 });
    }

    return Response.json({ message: 'Post deleted successfully' });
  }

  /**
   * DELETE /api/posts/:id/hard - Hard delete post (permanently)
   */
  if (url.pathname.match(/^\/api\/posts\/\d+\/hard$/)) {
    const id = parseInt(url.pathname.split('/')[3]);

    const success = await postService.hardDeletePost(id);

    if (!success) {
      return Response.json({ error: 'Post not found' }, { status: 404 });
    }

    return Response.json({ message: 'Post permanently deleted' });
  }

  return Response.json({ error: 'Not found' }, { status: 404 });
}
