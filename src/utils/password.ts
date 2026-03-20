// Password hashing using HMAC-SHA256 + SECRET_KEY (Web Crypto API — Workers compatible)
const encoder = new TextEncoder();

/**
 * Hash password ด้วย HMAC-SHA256 + PASSWORD_SECRET
 * Returns: hex string 64 characters
 */
export async function hashPassword(password: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(password));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
