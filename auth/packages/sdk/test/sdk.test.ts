import { SignJWT, generateKeyPair } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CookieJar, createHarness, GOOD_PASSWORD, ORIGIN, PLATFORM_KEY, type Harness } from '../../server/test/helpers.js';
import { totpCode, currentStep } from '../../server/src/lib/totp.js';
import { base32Decode } from '../../server/test/totp-util.js';
import { createAuthClient, BasaltAuthError, type AuthClient } from '../src/client.js';
import { createAuthServer, type AuthServer } from '../src/server.js';

const AUTH_URL = 'https://auth.test';
let h: Harness;
let pid: string;
let secretKey: string;
let n = 0;
const email = () => `sdk${++n}-${Date.now()}@example.com`;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

/** Routes fetches to the in-process auth server, like the network would. */
const serverFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url, AUTH_URL);
  return h.app.request(url.pathname + url.search, init as RequestInit);
};

/** A browser: keeps cookies and stamps Origin on non-GET requests, like real browsers do. */
function browser() {
  const jar = new CookieJar();
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') headers.set('origin', ORIGIN);
    if (jar.cookies.size) headers.set('cookie', jar.header());
    const res = await serverFetch(input, { ...init, headers });
    jar.absorb(res);
    return res;
  };
  return { jar, fetch: fetchImpl };
}

/** A request arriving at the developer's own backend, from that browser. */
function appRequest(jar: CookieJar, opts: { method?: string; origin?: string; host?: string } = {}) {
  const headers = new Headers({ cookie: jar.header(), host: opts.host ?? 'app.example.com' });
  if (opts.origin) headers.set('origin', opts.origin);
  return new Request('https://app.example.com/api/thing', { method: opts.method ?? 'GET', headers });
}

let server: AuthServer;
beforeEach(async () => {
  ({ projectId: pid, secretKey } = await h.createProject());
  server = createAuthServer({ projectId: pid, authUrl: AUTH_URL, secretKey, fetch: serverFetch });
});

function client(b = browser()): AuthClient {
  return createAuthClient({ baseUrl: `/v1/projects/${pid}`, fetch: b.fetch });
}

async function signedUp() {
  const b = browser();
  const c = client(b);
  const addr = email();
  expect(await c.signUp({ email: addr, password: GOOD_PASSWORD })).toEqual({ status: 'verification_required' });
  const { user } = await c.verifySignUp({ code: await h.lastCode(addr) });
  return { b, c, user, addr };
}

describe('browser client', () => {
  it('signs up, verifies, and reports the user without ever exposing tokens to JS', async () => {
    const b = browser();
    const c = client(b);
    const seen: unknown[] = [];
    c.onChange((u) => seen.push(u?.email ?? null));
    const addr = email();
    await c.signUp({ email: addr, password: GOOD_PASSWORD });
    const res = await c.verifySignUp({ code: await h.lastCode(addr) });
    expect(res.user.email).toBe(addr);
    expect(JSON.stringify(res)).not.toMatch(/bslt_rt_|eyJ/);
    expect(seen).toEqual([addr]);
    expect((await c.getUser())?.email).toBe(addr);
    // A fresh page load (new client, same cookies) restores the session.
    expect((await client(b).getUser())?.email).toBe(addr);
  });

  it('surfaces typed errors', async () => {
    const c = client();
    const err = await c.signIn({ email: email(), password: 'whatever-password-1' }).catch((e) => e);
    expect(err).toBeInstanceOf(BasaltAuthError);
    expect(err.code).toBe('invalid_credentials');
    expect(err.status).toBe(401);
  });

  it('completes MFA sign-in through submitMfaCode', async () => {
    const { c, addr } = await signedUp();
    const { secret } = await c.mfa.enroll();
    const key = base32Decode(secret);
    const { recoveryCodes } = await c.mfa.confirm({ code: totpCode(key, currentStep()) });
    expect(recoveryCodes).toHaveLength(10);
    await c.signOut();

    const c2 = client();
    expect(await c2.signIn({ email: addr, password: GOOD_PASSWORD })).toEqual({ status: 'mfa_required' });
    const { user } = await c2.submitMfaCode({ code: recoveryCodes[0]! });
    expect(user.mfaEnabled).toBe(true);
  });

  it('signs out and clears the session', async () => {
    const { b, c } = await signedUp();
    await c.signOut();
    expect(await c.getUser()).toBeNull();
    expect(await client(b).getUser()).toBeNull();
  });

  it('refreshes transparently when the access cookie is gone', async () => {
    const { b, user } = await signedUp();
    b.jar.cookies.delete('__Host-basalt_at'); // expired and evicted by the browser
    const fresh = client(b);
    expect((await fresh.getUser())?.id).toBe(user.id);
    expect(b.jar.cookies.has('__Host-basalt_at')).toBe(true);
  });

  it('auth.fetch retries a backend call once after refreshing', async () => {
    const { b } = await signedUp();
    b.jar.cookies.delete('__Host-basalt_at');
    let calls = 0;
    const backend: typeof fetch = async (input, init) => {
      if (String(input).startsWith('/v1/')) return b.fetch(input, init);
      calls++;
      const u = await server.getUser(appRequest(b.jar));
      return new Response(JSON.stringify({ id: u?.id ?? null }), { status: u ? 200 : 401 });
    };
    const c = createAuthClient({ baseUrl: `/v1/projects/${pid}`, fetch: backend });
    const res = await c.fetch('/api/me');
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });
});

describe('backend SDK', () => {
  it('reads the session cookie and verifies it locally', async () => {
    const { b, user, addr } = await signedUp();
    const u = await server.getUser(appRequest(b.jar));
    expect(u).toMatchObject({ id: user.id, email: addr, emailVerified: true, mfa: false, amr: ['pwd'] });
  });

  it('accepts Node-style request objects (Express)', async () => {
    const { b, user } = await signedUp();
    const u = await server.getUser({ method: 'GET', headers: { cookie: b.jar.header(), host: 'app.example.com' } });
    expect(u?.id).toBe(user.id);
  });

  it('blocks cookie-authenticated writes from other sites (CSRF) but allows same-origin writes', async () => {
    const { b, user } = await signedUp();
    expect(await server.getUser(appRequest(b.jar, { method: 'POST', origin: 'https://evil.example' }))).toBeNull();
    expect((await server.getUser(appRequest(b.jar, { method: 'POST', origin: 'https://app.example.com' })))?.id).toBe(user.id);
    // Bearer tokens aren't ambient credentials, so no Origin check applies.
    const native = (await (await serverFetch(`/v1/projects/${pid}/signin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: GOOD_PASSWORD }),
    })).json()) as any;
    const req = new Request('https://api.example.com/x', { method: 'POST', headers: { authorization: `Bearer ${native.accessToken}`, origin: 'https://evil.example' } });
    expect((await server.getUser(req))?.id).toBe(user.id);
  });

  it('requireUser enforces sign-in, verified email and MFA', async () => {
    await expect(server.requireUser(new Request('https://app.example.com/'))).rejects.toMatchObject({ status: 401 });
    const { b } = await signedUp();
    await expect(server.requireUser(appRequest(b.jar), { mfa: true })).rejects.toMatchObject({ status: 403, code: 'mfa_required' });
    await expect(server.requireUser(appRequest(b.jar), { emailVerified: true })).resolves.toBeTruthy();
  });

  it('rejects forged, foreign and tampered tokens', async () => {
    const { b } = await signedUp();
    const real = b.jar.cookies.get('__Host-basalt_at')!;
    const [hd, body, sig] = real.split('.');
    const payload = JSON.parse(Buffer.from(body!, 'base64url').toString());
    const evilBody = Buffer.from(JSON.stringify({ ...payload, sub: '00000000-0000-7000-8000-000000000000' })).toString('base64url');
    const tampered = `${hd}.${evilBody}.${sig}`;
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'at+jwt' })).toString('base64url')}.${body}.`;
    const { privateKey } = await generateKeyPair('EdDSA');
    const forged = await new SignJWT(payload).setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: JSON.parse(Buffer.from(hd!, 'base64url').toString()).kid }).sign(privateKey);
    for (const token of [tampered, none, forged, 'garbage', '']) {
      expect(await server.verifyAccessToken(token), token.slice(0, 20)).toBeNull();
    }
    const other = await h.createProject();
    const otherServer = createAuthServer({ projectId: other.projectId, authUrl: AUTH_URL, fetch: serverFetch });
    expect(await otherServer.verifyAccessToken(real)).toBeNull();
  });

  it('strict mode sees revocations immediately', async () => {
    const { b, c } = await signedUp();
    const req = () => appRequest(b.jar);
    const snapshot = b.jar.header();
    await c.signOut();
    const stale = new Request('https://app.example.com/', { headers: { cookie: snapshot, host: 'app.example.com' } });
    expect(await server.getUser(stale)).not.toBeNull(); // bounded lag: token still within its TTL
    expect(await server.getUser(stale, { strict: true })).toBeNull();
    expect(await server.getUser(req())).toBeNull(); // cookie was cleared
  });

  it('picks up rotated signing keys automatically', async () => {
    const { b, addr } = await signedUp();
    expect(await server.getUser(appRequest(b.jar))).not.toBeNull(); // warms JWKS cache
    await new Promise((r) => setTimeout(r, 1100)); // past the SDK's refetch cooldown
    await serverFetch(`/v1/platform/projects/${pid}/rotate-signing-key`, { method: 'POST', headers: { authorization: `Bearer ${PLATFORM_KEY}`, 'x-basalt-owner': 'ws_test' } });
    const b2 = browser();
    await client(b2).signIn({ email: addr, password: GOOD_PASSWORD });
    expect((await server.getUser(appRequest(b2.jar)))?.email).toBe(addr);
  });

  it('manages users with the secret key', async () => {
    const { user } = await signedUp();
    const updated = await server.admin.updateUser(user.id, { metadata: { role: 'admin', plan: 'pro' } });
    expect(updated.metadata).toEqual({ role: 'admin', plan: 'pro' });
    const { users } = await server.admin.listUsers({ email: user.email.toUpperCase() });
    expect(users.map((u) => u.id)).toEqual([user.id]);
    expect((await server.admin.revokeSessions(user.id)).revoked).toBe(1);
    await server.admin.deleteUser(user.id);
    await expect(server.admin.getUser(user.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('express middleware sets req.auth and answers 401 when required', async () => {
    const { b, user } = await signedUp();
    const run = (mw: ReturnType<AuthServer['middleware']>, req: any) =>
      new Promise<{ req: any; status?: number; body?: string }>((resolve) => {
        const res: any = { setHeader() {}, end(body: string) { resolve({ req, status: res.statusCode, body }); } };
        mw(req, res, () => resolve({ req }));
      });
    const ok = await run(server.middleware(), { method: 'GET', headers: { cookie: b.jar.header(), host: 'app.example.com' } });
    expect(ok.req.auth.id).toBe(user.id);
    const anon = await run(server.middleware(), { method: 'GET', headers: {} });
    expect(anon.req.auth).toBeNull();
    const denied = await run(server.middleware({ required: true }), { method: 'GET', headers: {} });
    expect(denied.status).toBe(401);
  });

  it('fails fast on missing configuration', () => {
    expect(() => createAuthServer({ projectId: undefined, authUrl: AUTH_URL })).toThrow(/projectId/);
    expect(() => createAuthServer({ projectId: pid, authUrl: '' })).toThrow(/authUrl/);
  });
});
