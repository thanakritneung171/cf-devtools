import { verifyJWT } from './jwt';

interface AuthEnv {
  JWT_SECRET?: string;
  USERS_CACHE: KVNamespace;
}

export async function verifyRequestAuth(req: Request, env: AuthEnv): Promise<Response | Record<string, any>> {
  const secret = env.JWT_SECRET;
  if (!secret) {
    return Response.json({ error: 'JWT secret ไม่ได้ถูกตั้งค่า (env.JWT_SECRET)' }, { status: 500 });
  }

  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return Response.json({ error: 'ต้องแนบ Authorization: Bearer <token>' }, { status: 401 });
  }

  const token = authHeader.split(' ')[1];
  const payload = await verifyJWT(token, secret);
  if (!payload) {
    return Response.json({ error: 'token ไม่ถูกต้องหรือหมดอายุ' }, { status: 401 });
  }

  // Check revocation in KV
  try {
    const jti = (payload as any).jti;
    if (jti) {
      const revoked = await env.USERS_CACHE.get(`revoked:${jti}`);
      if (revoked) {
        return Response.json({ error: 'token ถูกยกเลิกแล้ว' }, { status: 401 });
      }
    }
  } catch (e) {
    // ignore KV errors
  }

  return payload as Record<string, any>;
}
