import { UserService } from '../services/UserService';
import { CreateUserInput, CreateUserWithAvatarInput, UpdateUserInput } from '../types';

interface Env {
  DB: D1Database;
  USERS_CACHE: KVNamespace;
  MY_BUCKET: R2Bucket;
  R2_DOMAIN: string;
}

// R2 Domain - Auto-read from environment variable
// Update in wrangler.jsonc: vars.R2_DOMAIN
const getR2Domain = (env: Env): string => {
  return env.R2_DOMAIN || 'https://pub-5996ee0506414893a70d525a21960eba.r2.dev';
};

export async function handleUserRoutes(request: Request, env: Env, url: URL, method: string): Promise<Response | null> {
  const userService = new UserService(env);

  // Create User - POST /api/users (JSON หรือ Form Data)
  if (url.pathname === '/api/users' && method === 'POST') {
    try {
      const contentType = request.headers.get('content-type') || '';
      let user;

      // Check if request is multipart/form-data (with file upload)
      if (contentType.includes('multipart/form-data')) {
        const formData = await request.formData();
        const file = formData.get('file') as File | null;

        const data: CreateUserWithAvatarInput = {
          email: formData.get('email') as string,
          password_hash: formData.get('password_hash') as string,
          first_name: formData.get('first_name') as string,
          last_name: formData.get('last_name') as string,
          address: (formData.get('address') as string) || undefined,
          phone: (formData.get('phone') as string) || undefined,
          date_of_birth: (formData.get('date_of_birth') as string) || undefined,
          status: (formData.get('status') as string) || 'active',
          file: file || undefined,
        };

        // Validation
        if (!data.email || !data.password_hash || !data.first_name || !data.last_name) {
          return Response.json(
            { error: 'กรุณากรอกข้อมูลที่จำเป็น: email, password_hash, first_name, last_name' },
            { status: 400 }
          );
        }

        // Validate file if provided
        if (file && !file.type.startsWith('image/')) {
          return Response.json(
            { error: 'ไฟล์ต้องเป็นรูปภาพ (image/*)' },
            { status: 400 }
          );
        }

        if (file && file.size > 5 * 1024 * 1024) {
          return Response.json(
            { error: 'ขนาดไฟล์ต้องน้อยกว่า 5MB' },
            { status: 400 }
          );
        }

        user = await userService.createUserWithAvatar(data, getR2Domain(env));
      } else {
        // JSON request
        const body = await request.json<CreateUserInput>();

        // Validation
        if (!body.email || !body.password_hash || !body.first_name || !body.last_name) {
          return Response.json(
            { error: 'กรุณากรอกข้อมูลที่จำเป็น: email, password_hash, first_name, last_name' },
            { status: 400 }
          );
        }

        user = await userService.createUser(body);
      }

      return Response.json(user, { status: 201 });
    } catch (error: any) {
      return Response.json(
        { error: error.message || 'ไม่สามารถสร้างผู้ใช้ได้' },
        { status: 500 }
      );
    }
  }

  // Get All Users with Pagination, Filter, Search - GET /api/users
  if (url.pathname === '/api/users' && method === 'GET') {
    try {
      const page = parseInt(url.searchParams.get('page') || '1');
      const limit = parseInt(url.searchParams.get('limit') || '10');
      const status = url.searchParams.get('status') || undefined;
      const search = url.searchParams.get('search') || undefined;

      const result = await userService.getAllUsers(
        { page, limit },
        { status, search }
      );

      return Response.json(result);
    } catch (error: any) {
      return Response.json(
        { error: error.message || 'ไม่สามารถเรียกข้อมูลผู้ใช้ได้' },
        { status: 500 }
      );
    }
  }

  // Get User by ID - GET /api/users/:id
  if (url.pathname.startsWith('/api/users/') && method === 'GET' && !url.pathname.endsWith('/avatar')) {
    try {
      const id = parseInt(url.pathname.split('/')[3]);
      
      if (isNaN(id)) {
        return Response.json(
          { error: 'รหัสผู้ใช้ไม่ถูกต้อง' },
          { status: 400 }
        );
      }

      const result = await userService.getUserByIdWithSource(id);

      if (!result) {
        return Response.json(
          { error: 'ไม่พบผู้ใช้' },
          { status: 404 }
        );
      }

      return Response.json(result);
    } catch (error: any) {
      return Response.json(
        { error: error.message || 'ไม่สามารถเรียกข้อมูลผู้ใช้ได้' },
        { status: 500 }
      );
    }
  }

  // Update User - PUT /api/users/:id
  if (url.pathname.startsWith('/api/users/') && method === 'PUT' && !url.pathname.endsWith('/avatar')) {
    try {
      const id = parseInt(url.pathname.split('/')[3]);
      
      if (isNaN(id)) {
        return Response.json(
          { error: 'รหัสผู้ใช้ไม่ถูกต้อง' },
          { status: 400 }
        );
      }

      const body = await request.json<UpdateUserInput>();

      const user = await userService.updateUser(id, body);
      
      if (!user) {
        return Response.json(
          { error: 'ไม่พบผู้ใช้' },
          { status: 404 }
        );
      }

      return Response.json(user);
    } catch (error: any) {
      return Response.json(
        { error: error.message || 'ไม่สามารถแก้ไขผู้ใช้ได้' },
        { status: 500 }
      );
    }
  }

  // Upload User Avatar - POST /api/users/:id/avatar
  if (url.pathname.match(/^\/api\/users\/\d+\/avatar$/) && method === 'POST') {
    try {
      const id = parseInt(url.pathname.split('/')[3]);
      
      if (isNaN(id)) {
        return Response.json(
          { error: 'รหัสผู้ใช้ไม่ถูกต้อง' },
          { status: 400 }
        );
      }

      const user = await userService.getUserById(id);
      if (!user) {
        return Response.json(
          { error: 'ไม่พบผู้ใช้' },
          { status: 404 }
        );
      }

      const formData = await request.formData();
      const file = formData.get('file') as File;

      if (!file) {
        return Response.json(
          { error: 'กรุณาระบุไฟล์รูปภาพ' },
          { status: 400 }
        );
      }

      // Validate file type
      if (!file.type.startsWith('image/')) {
        return Response.json(
          { error: 'ไฟล์ต้องเป็นรูปภาพ (image/*)' },
          { status: 400 }
        );
      }

      // Validate file size (max 5MB)
      if (file.size > 5 * 1024 * 1024) {
        return Response.json(
          { error: 'ขนาดไฟล์ต้องน้อยกว่า 5MB' },
          { status: 400 }
        );
      }

      // Generate filename
      const timestamp = Date.now();
      const fileExtension = file.type.split('/')[1];
      const filename = `users/${id}/avatar-${timestamp}.${fileExtension}`;

      // Upload to R2
      const arrayBuffer = await file.arrayBuffer();
      await env.MY_BUCKET.put(filename, arrayBuffer, {
        httpMetadata: {
          contentType: file.type,
        },
      });

      // Generate public URL (auto from environment)
      const avatarUrl = `${getR2Domain(env)}/${filename}`;

      // Update user with avatar URL
      const updatedUser = await userService.updateUserAvatarUrl(id, avatarUrl);

      return Response.json(updatedUser, { status: 200 });
    } catch (error: any) {
      return Response.json(
        { error: error.message || 'ไม่สามารถอัพโหลดรูปภาพได้' },
        { status: 500 }
      );
    }
  }

  // Delete User - DELETE /api/users/:id
  if (url.pathname.startsWith('/api/users/') && method === 'DELETE' && !url.pathname.endsWith('/avatar')) {
    try {
      const id = parseInt(url.pathname.split('/')[3]);
      
      if (isNaN(id)) {
        return Response.json(
          { error: 'รหัสผู้ใช้ไม่ถูกต้อง' },
          { status: 400 }
        );
      }

      const success = await userService.deleteUser(id);

      if (!success) {
        return Response.json(
          { error: 'ไม่พบผู้ใช้' },
          { status: 404 }
        );
      }

      return Response.json({ message: 'ลบผู้ใช้สำเร็จ' });
    } catch (error: any) {
      return Response.json(
        { error: error.message || 'ไม่สามารถลบผู้ใช้ได้' },
        { status: 500 }
      );
    }
  }

  return null;
}
