import { UserService } from '../services/UserService';
import { CreateUserInput, CreateUserWithAvatarInput, UpdateUserInput } from '../types';
import { generateJWT } from '../utils/jwt';
import { hashPassword } from '../utils/password';
import { verifyRequestAuth } from '../utils/auth';
import { ImageResizeMessage } from '../queues/imageResizeConsumer';

interface Env {
  DB: D1Database;
  USERS_CACHE: KVNamespace;
  USERS_Profile: KVNamespace;
  MY_BUCKET: R2Bucket;
  R2_DOMAIN: string;
  JWT_SECRET?: string;
  PASSWORD_SECRET?: string;
  IMAGE_RESIZE_QUEUE: Queue<ImageResizeMessage>;
}

const PROFILE_TTL = 60 * 60 * 3; // 3 hours   seconds * minutes * hours
const getProfileKey = (userId: number) => `profile:${userId}`;

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

        const password_hash = formData.get('password_hash') as string;

        // Validation
        if (!formData.get('email') || !password_hash || !formData.get('first_name') || !formData.get('last_name')) {
          return Response.json(
            { error: 'กรุณากรอกข้อมูลที่จำเป็น: email, password_hash, first_name, last_name' },
            { status: 400 }
          );
        }

        const pwSecret = env.PASSWORD_SECRET;
        if (!pwSecret) {
          return Response.json({ error: 'PASSWORD_SECRET ไม่ได้ถูกตั้งค่า' }, { status: 500 });
        }

        const data: CreateUserWithAvatarInput = {
          email: formData.get('email') as string,
          password_hash: await hashPassword(password_hash, pwSecret),
          first_name: formData.get('first_name') as string,
          last_name: formData.get('last_name') as string,
          address: (formData.get('address') as string) || undefined,
          phone: (formData.get('phone') as string) || undefined,
          date_of_birth: (formData.get('date_of_birth') as string) || undefined,
          status: (formData.get('status') as string) || 'active',
          role: (formData.get('role') as string) || 'User',
          file: file || undefined,
        };

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

        // 🎯 ส่ง message ไปยัง Queue เพื่อ resize รูปภาพ (ถ้ามีไฟล์)
        if (file && user.avatar_url) {
          const filename = user.avatar_url.split('/').slice(-3).join('/'); // Extract: users/{id}/avatar-xxx.jpg
          await env.IMAGE_RESIZE_QUEUE.send({
            userId: user.id,
            originalFilename: filename,
            contentType: file.type,
            timestamp: Date.now(),
          });
          console.log(`[Queue] 📤 Sent image resize task to queue for user ${user.id}`);
        }
      } else {
        // JSON request
        const body = await request.json<Omit<CreateUserInput, 'password_hash'> & { password_hash: string }>();

        // Validation
        if (!body.email || !body.password_hash || !body.first_name || !body.last_name) {
          return Response.json(
            { error: 'กรุณากรอกข้อมูลที่จำเป็น: email, password, first_name, last_name' },
            { status: 400 }
          );
        }

        const pwSecret = env.PASSWORD_SECRET;
        if (!pwSecret) {
          return Response.json({ error: 'PASSWORD_SECRET ไม่ได้ถูกตั้งค่า' }, { status: 500 });
        }

        user = await userService.createUser({
          ...body,
          password_hash: await hashPassword(body.password_hash, pwSecret),
        });
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
      // Require auth
      const authCheck = await verifyRequestAuth(request, env);
      if (authCheck instanceof Response) return authCheck;

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
      // Require auth
      const authCheck = await verifyRequestAuth(request, env);
      if (authCheck instanceof Response) return authCheck;

      const id = parseInt(url.pathname.split('/')[3]);

      if (isNaN(id)) {
        return Response.json(
          { error: 'รหัสผู้ใช้ไม่ถูกต้อง' },
          { status: 400 }
        );
      }

      // ดึงจาก KV USERS_Profile ก่อน
      const profileCached = await env.USERS_Profile.get(getProfileKey(id));
      if (profileCached) {
        return Response.json({ user: JSON.parse(profileCached), source: 'profile_cache' });
      }

      // ไม่มีใน USERS_Profile → ดึงจาก service (USERS_CACHE + D1)
      const result = await userService.getUserByIdWithSource(id);

      if (!result) {
        return Response.json(
          { error: 'ไม่พบผู้ใช้' },
          { status: 404 }
        );
      }

      // เก็บลง USERS_Profile สำหรับครั้งถัดไป
      await env.USERS_Profile.put(
        getProfileKey(id),
        JSON.stringify(result.user),
        { expirationTtl: PROFILE_TTL }
      );

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
      // Require auth
      const authCheck = await verifyRequestAuth(request, env);
      if (authCheck instanceof Response) return authCheck;

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

      // Invalidate USERS_Profile KV
      await env.USERS_Profile.delete(getProfileKey(id));

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

      // Invalidate USERS_Profile KV
      await env.USERS_Profile.delete(getProfileKey(id));

      // 🎯 ส่ง message ไปยัง Queue เพื่อ resize รูปภาพ
      await env.IMAGE_RESIZE_QUEUE.send({
        userId: id,
        originalFilename: filename,
        contentType: file.type,
        timestamp: Date.now(),
      });
      console.log(`[Queue] 📤 Sent image resize task to queue for user ${id}`);

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
      // Require auth
      const authCheck = await verifyRequestAuth(request, env);
      if (authCheck instanceof Response) return authCheck;

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

      // Invalidate USERS_Profile KV
      await env.USERS_Profile.delete(getProfileKey(id));

      return Response.json({ message: 'ลบผู้ใช้สำเร็จ' });
    } catch (error: any) {
      return Response.json(
        { error: error.message || 'ไม่สามารถลบผู้ใช้ได้' },
        { status: 500 }
      );
    }
  }

  // Update User Role - PATCH /api/users/:id/role
  if (url.pathname.match(/^\/api\/users\/\d+\/role$/) && method === 'PATCH') {
    try {
      const authCheck = await verifyRequestAuth(request, env);
      if (authCheck instanceof Response) return authCheck;

      const id = parseInt(url.pathname.split('/')[3]);
      if (isNaN(id)) {
        return Response.json({ error: 'รหัสผู้ใช้ไม่ถูกต้อง' }, { status: 400 });
      }

      const body = await request.json<{ role: string }>();
      if (!body.role) {
        return Response.json({ error: 'กรุณาระบุ role (Admin หรือ User)' }, { status: 400 });
      }
      if (!['Admin', 'User'].includes(body.role)) {
        return Response.json({ error: 'role ต้องเป็น Admin หรือ User เท่านั้น' }, { status: 400 });
      }

      const user = await userService.updateUser(id, { role: body.role });
      if (!user) {
        return Response.json({ error: 'ไม่พบผู้ใช้' }, { status: 404 });
      }

      // Invalidate USERS_Profile KV
      await env.USERS_Profile.delete(getProfileKey(id));

      return Response.json(user);
    } catch (error: any) {
      return Response.json({ error: error.message || 'ไม่สามารถแก้ไข role ได้' }, { status: 500 });
    }
  }

  // Auth - Login (email + password) - POST /api/auth/login
  if (url.pathname === '/api/auth/login' && method === 'POST') {
    try {
      const body = await request.json() as { email?: string; password_hash?: string };
      const email = body.email;
      const password = body.password_hash;

      if (!email || !password) {
        return Response.json({ error: 'กรุณาส่ง email และ password' }, { status: 400 });
      }

      const pwSecret = env.PASSWORD_SECRET;
      if (!pwSecret) {
        return Response.json({ error: 'PASSWORD_SECRET ไม่ได้ถูกตั้งค่า' }, { status: 500 });
      }

      const user = await userService.getUserByEmail(email);
      if (!user) {
        return Response.json({ error: 'ไม่พบผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' }, { status: 401 });
      }

      // Hash password ที่รับมาแล้วเทียบกับที่เก็บใน DB
      const hashedInput = await hashPassword(password, pwSecret);
      if (user.password_hash !== hashedInput) {
        return Response.json({ error: 'ไม่พบผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' }, { status: 401 });
      }

      // Update last_login_at
      const now = new Date().toISOString();
      await userService.updateUser(user.id, { last_login_at: now });

      // Return user (without password_hash)
      const { password_hash: _ph, ...userSafe } = (await userService.getUserById(user.id)) as any;

      // Generate JWT token
      const secret = (env as any).JWT_SECRET;
      if (!secret) {
        return Response.json({ error: 'JWT secret ไม่ได้ถูกตั้งค่า (env.JWT_SECRET)' }, { status: 500 });
      }

      const token = await generateJWT({ sub: user.id, email: user.email }, secret, 3600);

      // เก็บ user profile ลง KV USERS_Profile
      await env.USERS_Profile.put(
        getProfileKey(user.id),
        JSON.stringify(userSafe),
        { expirationTtl: PROFILE_TTL }
      );

      return Response.json({ user: userSafe, token, message: 'เข้าสู่ระบบสำเร็จ' }, { status: 200 });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ไม่สามารถเข้าสู่ระบบได้' }, { status: 500 });
    }
  }

  // Auth - Logout (stateless placeholder) - POST /api/auth/logout
  if (url.pathname === '/api/auth/logout' && method === 'POST') {
    try {
      // Require auth and revoke token
      const authCheck = await verifyRequestAuth(request, env);
      if (authCheck instanceof Response) return authCheck;

      const payload: any = authCheck;
      const jti = payload.jti;
      const exp = payload.exp;
      if (!jti || !exp) {
        return Response.json({ error: 'token ไม่มี jti/exp และไม่สามารถยกเลิกได้' }, { status: 400 });
      }

      const now = Math.floor(Date.now() / 1000);
      const ttl = Math.max(1, exp - now);

      // Store revoked jti in KV so verifyRequestAuth will reject it
      try {
        await (env as any).USERS_CACHE.put(`revoked:${jti}`, '1', { expirationTtl: ttl });
      } catch (e: any) {
        return Response.json({ error: 'ไม่สามารถบันทึกสถานะยกเลิก token ใน KV ได้' }, { status: 500 });
      }

      // Invalidate USERS_Profile KV
      if (payload.sub) {
        await env.USERS_Profile.delete(getProfileKey(Number(payload.sub)));
      }

      return Response.json({ message: 'ออกจากระบบสำเร็จ' });
    } catch (error: any) {
      return Response.json({ error: error.message || 'ไม่สามารถออกจากระบบได้' }, { status: 500 });
    }
  }

  return null;
}
