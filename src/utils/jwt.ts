// Minimal JWT HS256 implementation using Web Crypto API (Workers-compatible)
const encoder = new TextEncoder();

function base64UrlEncode(buffer: Uint8Array | ArrayBuffer | string) {
  let bytes: Uint8Array;
  if (typeof buffer === 'string') bytes = encoder.encode(buffer);
  else if (buffer instanceof ArrayBuffer) bytes = new Uint8Array(buffer);
  else bytes = buffer as Uint8Array;

  let base64 = btoa(String.fromCharCode(...Array.from(bytes)));
  return base64.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function signHMACSHA256(message: string, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return base64UrlEncode(sig as ArrayBuffer);
}

export async function generateJWT(payload: Record<string, any>, secret: string, expiresInSec = 3600) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + expiresInSec;
  const jti = (crypto as any).randomUUID ? (crypto as any).randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
  const fullPayload = { ...payload, iat, exp, jti };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await signHMACSHA256(signingInput, secret);
  return `${signingInput}.${signature}`;
}

export async function verifyJWT(token: string, secret: string) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB, payloadB, sig] = parts;
    const signingInput = `${headerB}.${payloadB}`;
    const expectedSig = await signHMACSHA256(signingInput, secret);
    if (sig !== expectedSig) return null;
    const payloadStr = atob(payloadB.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(payloadStr);
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}
