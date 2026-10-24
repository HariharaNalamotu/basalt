import { createHmac, randomUUID } from 'node:crypto';

// Makes login tokens shaped like the ones Supabase Auth issues, for tests only.

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export interface TokenOptions {
  sub?: string;
  secret?: string;
  alg?: string;
  expiresIn?: number;
  omitExp?: boolean;
  omitIat?: boolean;
  issuedAgo?: number;
  aud?: string;
  role?: string;
  extra?: Record<string, unknown>;
  // Applied last, so it can replace exp or iat.
  override?: Record<string, unknown>;
}

export function makeToken(options: TokenOptions = {}): string {
  const secret = options.secret ?? process.env.BASALT_JWT_SECRET!;
  const header = { alg: options.alg ?? 'HS256', typ: 'JWT' };
  const payload: Record<string, unknown> = {
    sub: options.sub ?? randomUUID(),
    aud: options.aud ?? 'authenticated',
    role: options.role ?? 'authenticated',
    ...options.extra,
  };
  const now = Math.floor(Date.now() / 1000);
  if (!options.omitIat) payload.iat = now - (options.issuedAgo ?? 0);
  if (!options.omitExp) payload.exp = now + (options.expiresIn ?? 600);
  Object.assign(payload, options.override);

  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = options.alg === 'none' ? '' : createHmac('sha256', secret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

export function userToken(sub: string): string {
  return makeToken({ sub });
}
