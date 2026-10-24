import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compact signed tokens: base64url(payload).base64url(HMAC-SHA256(key, payload)).
 * Payload is JSON with an `exp` (unix seconds). Used for environment access links, clearance
 * cookies and internal capabilities. Never contains secrets.
 */
export function signToken(key: string, payload: Record<string, unknown> & { exp: number }): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyToken<T extends { exp: number }>(key: string, token: string | undefined | null, nowMs = Date.now()): T | null {
  if (!token || token.length > 2048) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = createHmac('sha256', key).update(body).digest();
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < nowMs) return null;
    return payload;
  } catch {
    return null;
  }
}

export function hmacHex(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
