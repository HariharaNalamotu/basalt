import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CookieJar, createHarness, GOOD_PASSWORD, ORIGIN, PLATFORM_KEY, type Harness } from './helpers.js';

let h: Harness;
let pid: string;
let secretKey: string;
let n = 0;
const uniqueEmail = () => `user${++n}-${Date.now()}@example.com`;
const base = () => `/v1/projects/${pid}`;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  ({ projectId: pid, secretKey } = await h.createProject());
  h.clock.offsetMs = 0;
});

/** Full browser sign-up through email verification. Returns the cookie jar holding the session. */
async function browserSignUp(email = uniqueEmail(), password = GOOD_PASSWORD) {
  const jar = new CookieJar();
  const res = await h.request('POST', `${base()}/signup`, { origin: ORIGIN, jar, body: { email, password } });
  expect(res.status).toBe(202);
  const { signupToken } = (await res.json()) as any;
  const code = await h.lastCode(email);
  const v = await h.request('POST', `${base()}/signup/verify`, { origin: ORIGIN, jar, body: { signupToken, code } });
  expect(v.status).toBe(201);
  return { jar, email, password, body: (await v.json()) as any };
}

async function nativeSignIn(email: string, password = GOOD_PASSWORD) {
  const res = await h.request('POST', `${base()}/signin`, { body: { email, password } });
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

describe('platform API', () => {
  it('rejects requests without the platform key', async () => {
    const res = await h.request('POST', '/v1/platform/projects', { body: { name: 'x' } });
    expect(res.status).toBe(401);
    const bad = await h.request('POST', '/v1/platform/projects', { bearer: 'wrong', body: { name: 'x' } });
    expect(bad.status).toBe(401);
  });

  it('refuses insecure origins and out-of-bounds settings', async () => {
    for (const origin of ['http://evil.com', 'http://localhost.evil.com', 'http://evil.com.localhost.evil', 'https://app.com/path', '*', 'https://*.app.com']) {
      const res = await h.request('POST', '/v1/platform/projects', { bearer: PLATFORM_KEY, body: { name: 'x', allowedOrigins: [origin] } });
      expect(res.status, origin).toBe(400);
    }
    const ok = await h.request('POST', '/v1/platform/projects', {
      bearer: PLATFORM_KEY,
      // *.localhost is loopback by definition (the one-laptop demo's apps live there).
      body: { name: 'x', allowedOrigins: ['http://localhost:5173', 'http://todo.basalt.localhost:8080'] },
    });
    expect(ok.status).toBe(201);
    for (const settings of [{ accessTokenTtlSeconds: 86_400 }, { passwordMinLength: 4 }, { sessionMaxLifetimeSeconds: 10 ** 9 }, { unknownKnob: true }]) {
      const res = await h.request('POST', '/v1/platform/projects', { bearer: PLATFORM_KEY, body: { name: 'x', settings } });
      expect(res.status, JSON.stringify(settings)).toBe(400);
    }
  });

  it('scopes every control-plane operation to the owning workspace', async () => {
    const asOther = { bearer: PLATFORM_KEY, owner: 'ws_someone_else' };
    for (const [method, path] of [
      ['GET', `/v1/platform/projects/${pid}`],
      ['PATCH', `/v1/platform/projects/${pid}`],
      ['DELETE', `/v1/platform/projects/${pid}`],
      ['POST', `/v1/platform/projects/${pid}/rotate-secret-key`],
      ['GET', `/v1/platform/projects/${pid}/users`],
      ['GET', `/v1/platform/projects/${pid}/events`],
    ] as const) {
      const res = await h.request(method, path, { ...asOther, body: method === 'GET' || method === 'DELETE' ? undefined : {} });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const list = (await (await h.request('GET', '/v1/platform/projects', asOther)).json()) as any;
    expect(list.projects).toEqual([]);
    const noOwner = await h.request('GET', `/v1/platform/projects/${pid}`, { bearer: PLATFORM_KEY, headers: { 'x-basalt-owner': '' } });
    expect(noOwner.status).toBe(400);
    // The owner can still see it.
    expect((await h.request('GET', `/v1/platform/projects/${pid}`, { bearer: PLATFORM_KEY })).status).toBe(200);
  });

  it('manages users through the control plane without a project secret key', async () => {
    const { body } = await browserSignUp();
    const users = (await (await h.request('GET', `/v1/platform/projects/${pid}/users`, { bearer: PLATFORM_KEY })).json()) as any;
    expect(users.users.map((u: any) => u.id)).toContain(body.user.id);
    const patched = await h.request('PATCH', `/v1/platform/projects/${pid}/users/${body.user.id}`, { bearer: PLATFORM_KEY, body: { metadata: { role: 'admin' } } });
    expect(((await patched.json()) as any).user.metadata.role).toBe('admin');
  });

  it('never returns the secret key after creation', async () => {
    const res = await h.request('GET', `/v1/platform/projects/${pid}`, { bearer: PLATFORM_KEY });
    const text = await res.text();
    expect(text).not.toContain(secretKey);
    expect(JSON.parse(text).project.secretKeyHint).toMatch(/^bslt_sk_.{4}…$/);
  });
});

describe('sign-up with email verification', () => {
  it('creates the account only after the code is verified, and sets HttpOnly cookies without exposing tokens', async () => {
    const email = uniqueEmail();
    const jar = new CookieJar();
    const res = await h.request('POST', `${base()}/signup`, { origin: ORIGIN, jar, body: { email, password: GOOD_PASSWORD } });
    expect(res.status).toBe(202);
    const { signupToken } = (await res.json()) as any;

    // Not an account yet: sign-in must fail.
    const early = await h.request('POST', `${base()}/signin`, { origin: ORIGIN, body: { email, password: GOOD_PASSWORD } });
    expect(early.status).toBe(401);

    const code = await h.lastCode(email);
    const v = await h.request('POST', `${base()}/signup/verify`, { origin: ORIGIN, jar, body: { signupToken, code } });
    expect(v.status).toBe(201);
    const body = (await v.json()) as any;
    expect(body.user.email).toBe(email);
    expect(body.user.emailVerified).toBe(true);
    expect(body.accessToken).toBeUndefined();
    expect(body.refreshToken).toBeUndefined();

    const setCookies = v.headers.getSetCookie();
    const at = setCookies.find((c) => c.startsWith('__Host-basalt_at='))!;
    const rt = setCookies.find((c) => c.startsWith('__Secure-basalt_rt='))!;
    expect(at).toMatch(/HttpOnly/i);
    expect(at).toMatch(/Secure/i);
    expect(at).toMatch(/SameSite=Lax/i);
    expect(at).toMatch(/Path=\//);
    expect(rt).toMatch(/HttpOnly/i);
    expect(rt).toMatch(/SameSite=Strict/i);
    expect(rt).toContain(`Path=/v1/projects/${pid}/session`);

    const me = await h.request('GET', `${base()}/session`, { origin: ORIGIN, jar });
    expect(me.status).toBe(200);
    expect(((await me.json()) as any).user.email).toBe(email);
  });

  it('does not reveal whether an email is registered', async () => {
    const { email } = await browserSignUp();
    const fresh = await h.request('POST', `${base()}/signup`, { origin: ORIGIN, body: { email: uniqueEmail(), password: GOOD_PASSWORD } });
    const dupe = await h.request('POST', `${base()}/signup`, { origin: ORIGIN, body: { email, password: GOOD_PASSWORD } });
    expect(dupe.status).toBe(fresh.status);
    const [a, b] = [(await fresh.json()) as any, (await dupe.json()) as any];
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(b.signupToken).toMatch(/^bslt_su_/);
    await h.services.accounts.drain();
    expect(h.mailer.outbox.some((m) => m.to === email && m.template === 'account_exists')).toBe(true);
    // The decoy token can never be redeemed.
    const v = await h.request('POST', `${base()}/signup/verify`, { origin: ORIGIN, body: { signupToken: b.signupToken, code: '000000' } });
    expect(v.status).toBe(400);
  });

  it('prevents account pre-hijacking: an attacker cannot complete a sign-up with the victim\'s code', async () => {
    const victim = uniqueEmail();
    const attacker = await h.request('POST', `${base()}/signup`, { origin: ORIGIN, body: { email: victim, password: 'attacker-chosen-pass-1' } });
    const attackerToken = ((await attacker.json()) as any).signupToken;
    await h.services.accounts.drain();

    const real = await h.request('POST', `${base()}/signup`, { origin: ORIGIN, body: { email: victim, password: GOOD_PASSWORD } });
    const victimToken = ((await real.json()) as any).signupToken;
    const victimCode = await h.lastCode(victim);

    // The attacker somehow learns the victim's code: still useless without the victim's signup token.
    const steal = await h.request('POST', `${base()}/signup/verify`, { origin: ORIGIN, body: { signupToken: attackerToken, code: victimCode } });
    expect(steal.status).toBe(400);

    const ok = await h.request('POST', `${base()}/signup/verify`, { origin: ORIGIN, body: { signupToken: victimToken, code: victimCode } });
    expect(ok.status).toBe(201);
    // The account has the victim's password, not the attacker's.
    expect((await h.request('POST', `${base()}/signin`, { body: { email: victim, password: 'attacker-chosen-pass-1' } })).status).toBe(401);
    expect((await h.request('POST', `${base()}/signin`, { body: { email: victim, password: GOOD_PASSWORD } })).status).toBe(200);
  });

  it('burns the pending sign-up after 5 wrong codes', async () => {
    const email = uniqueEmail();
    const res = await h.request('POST', `${base()}/signup`, { origin: ORIGIN, body: { email, password: GOOD_PASSWORD } });
    const { signupToken } = (await res.json()) as any;
    const code = await h.lastCode(email);
    const wrong = code === '111111' ? '222222' : '111111';
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await h.request('POST', `${base()}/signup/verify`, { origin: ORIGIN, body: { signupToken, code: wrong } })).status);
    }
    expect(statuses).toEqual([400, 400, 400, 400, 429]);
    const after = await h.request('POST', `${base()}/signup/verify`, { origin: ORIGIN, body: { signupToken, code } });
    expect(after.status).toBe(400);
  });

  it('enforces the password policy', async () => {
    const cases: Array<[string, string]> = [
      ['short', 'weak_password'],
      ['password1234', 'weak_password'],
      ['aaaaaaaaaaaaaaa', 'weak_password'],
      ['correct horse battery staple', 'breached_password'],
      ['x'.repeat(129), 'weak_password'],
    ];
    for (const [password, code] of cases) {
      const res = await h.request('POST', `${base()}/signup`, { origin: ORIGIN, body: { email: uniqueEmail(), password } });
      expect(res.status, password).toBe(400);
      expect(((await res.json()) as any).error.code).toBe(code);
    }
    const email = 'jonathan.smith@example.com';
    const res = await h.request('POST', `${base()}/signup`, { origin: ORIGIN, body: { email, password: 'jonathan.smith-is-great' } });
    expect(((await res.json()) as any).error.code).toBe('weak_password');
  });

  it('signs in immediately when verification is disabled, and reports duplicates', async () => {
    const { projectId } = await h.createProject({ settings: { requireEmailVerification: false } });
    const email = uniqueEmail();
    const res = await h.request('POST', `/v1/projects/${projectId}/signup`, { body: { email, password: GOOD_PASSWORD } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.user.emailVerified).toBe(false);
    expect(body.accessToken).toBeTruthy();
    const dupe = await h.request('POST', `/v1/projects/${projectId}/signup`, { body: { email: email.toUpperCase(), password: GOOD_PASSWORD } });
    expect(dupe.status).toBe(409);
  });
});

describe('sign-in', () => {
  it('returns identical errors for unknown email and wrong password', async () => {
    const { email } = await browserSignUp();
    const wrong = await h.request('POST', `${base()}/signin`, { body: { email, password: 'not-the-password-123' } });
    const unknown = await h.request('POST', `${base()}/signin`, { body: { email: uniqueEmail(), password: 'not-the-password-123' } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
  });

  it('is case-insensitive on email', async () => {
    const { email } = await browserSignUp();
    await nativeSignIn(`  ${email.toUpperCase()} `);
  });

  it('throttles guessing against a single account from one source', async () => {
    const { email } = await browserSignUp();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await h.request('POST', `${base()}/signin`, { ip: '198.51.100.7', body: { email, password: `guess-number-${i}-xx` } })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    const res = await h.request('POST', `${base()}/signin`, { ip: '198.51.100.7', body: { email, password: GOOD_PASSWORD } });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    // The real user, from their own network, is not locked out by someone else's guessing.
    expect((await h.request('POST', `${base()}/signin`, { ip: '192.0.2.44', body: { email, password: GOOD_PASSWORD } })).status).toBe(200);
  });

  it('caps distributed guessing against one account', async () => {
    const { email } = await browserSignUp();
    const statuses: number[] = [];
    for (let i = 0; i < 52; i++) {
      statuses.push((await h.request('POST', `${base()}/signin`, { ip: `198.51.${Math.floor(i / 250)}.${i % 250}`, body: { email, password: `guess-number-${i}-xx` } })).status);
    }
    expect(statuses.slice(0, 50).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(50)).toEqual([429, 429]);
  });

  it('rejects browser requests from origins not on the allow-list', async () => {
    const { email } = await browserSignUp();
    const res = await h.request('POST', `${base()}/signin`, { origin: 'https://evil.example', body: { email, password: GOOD_PASSWORD } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe('origin_not_allowed');
  });

  it('requires JSON bodies (blocks HTML-form CSRF)', async () => {
    const res = await h.request('POST', `${base()}/signin`, {
      origin: ORIGIN,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=a@b.co&password=x',
    });
    expect(res.status).toBe(400);
  });

  it('issues standards-compliant access tokens verifiable via the public JWKS', async () => {
    const { email } = await browserSignUp();
    const { accessToken, user } = await nativeSignIn(email);
    const jwks = (await (await h.request('GET', `${base()}/.well-known/jwks.json`)).json()) as any;
    expect(jwks.keys[0]).not.toHaveProperty('d');
    const { payload } = await jwtVerify(accessToken, createLocalJWKSet(jwks), {
      issuer: `https://auth.test/v1/projects/${pid}`,
      audience: pid,
      algorithms: ['EdDSA'],
      typ: 'at+jwt',
    });
    expect(payload.sub).toBe(user.id);
    expect(payload.email).toBe(email);
    expect(payload.email_verified).toBe(true);
    expect(payload.amr).toEqual(['pwd']);
    expect(payload.exp! - payload.iat!).toBe(600);
    expect(decodeProtectedHeader(accessToken).alg).toBe('EdDSA');
  });

  it('isolates projects: a token from one project is useless in another', async () => {
    const { email } = await browserSignUp();
    const { accessToken } = await nativeSignIn(email);
    const other = await h.createProject();
    const res = await h.request('GET', `/v1/projects/${other.projectId}/session`, { bearer: accessToken });
    expect(res.status).toBe(401);
    // Same email in another project is a different user.
    const s = await h.request('POST', `/v1/projects/${other.projectId}/signin`, { body: { email, password: GOOD_PASSWORD } });
    expect(s.status).toBe(401);
  });
});

describe('sessions', () => {
  it('rotates refresh tokens and revokes the session when an old one is replayed', async () => {
    const { email } = await browserSignUp();
    const first = await nativeSignIn(email);
    const r1 = await h.request('POST', `${base()}/session/refresh`, { body: { refreshToken: first.refreshToken } });
    expect(r1.status).toBe(200);
    const second = (await r1.json()) as any;
    expect(second.refreshToken).not.toBe(first.refreshToken);

    // Concurrent retry inside the grace window: rejected, but the session survives.
    const race = await h.request('POST', `${base()}/session/refresh`, { body: { refreshToken: first.refreshToken } });
    expect(race.status).toBe(409);

    // Replay after the grace window = theft. The whole session dies, including the attacker's fresh token.
    h.clock.offsetMs = 11_000;
    const replay = await h.request('POST', `${base()}/session/refresh`, { body: { refreshToken: first.refreshToken } });
    expect(replay.status).toBe(401);
    const legit = await h.request('POST', `${base()}/session/refresh`, { body: { refreshToken: second.refreshToken } });
    expect(legit.status).toBe(401);
    expect((await h.request('GET', `${base()}/session`, { bearer: second.accessToken })).status).toBe(401);

    const { events } = await h.services.admin.listEvents(pid, { userId: first.user.id });
    expect(events.some((e) => e.type === 'session.refresh_token_reuse')).toBe(true);
  });

  it('detects replay of tokens several generations old', async () => {
    const { email } = await browserSignUp();
    let cur = await nativeSignIn(email);
    const original = cur.refreshToken;
    for (let i = 0; i < 3; i++) {
      h.clock.offsetMs += 1000;
      cur = await (await h.request('POST', `${base()}/session/refresh`, { body: { refreshToken: cur.refreshToken } })).json();
    }
    const replay = await h.request('POST', `${base()}/session/refresh`, { body: { refreshToken: original } });
    expect(replay.status).toBe(401);
    expect((await h.request('POST', `${base()}/session/refresh`, { body: { refreshToken: cur.refreshToken } })).status).toBe(401);
  });

  it('rejects forged refresh tokens without revoking the real session', async () => {
    const { email } = await browserSignUp();
    const s = await nativeSignIn(email);
    const forged = s.refreshToken.replace(/_[^_]+$/, '_' + 'A'.repeat(43));
    expect((await h.request('POST', `${base()}/session/refresh`, { body: { refreshToken: forged } })).status).toBe(401);
    expect((await h.request('POST', `${base()}/session/refresh`, { body: { refreshToken: s.refreshToken } })).status).toBe(200);
  });

  it('refreshes browser sessions via cookie only, never accepting a body token from a browser', async () => {
    const { jar, email } = await browserSignUp();
    const native = await nativeSignIn(email);
    const before = jar.cookies.get('__Host-basalt_at');
    h.clock.offsetMs = 1000;
    const res = await h.request('POST', `${base()}/session/refresh`, { origin: ORIGIN, jar, body: {} });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).accessToken).toBeUndefined();
    expect(jar.cookies.get('__Host-basalt_at')).not.toBe(before);
    // A browser request carrying a token in the body (e.g. XSS-exfiltrated) is ignored.
    const bodyOnly = await h.request('POST', `${base()}/session/refresh`, { origin: ORIGIN, body: { refreshToken: native.refreshToken } });
    expect(bodyOnly.status).toBe(401);
  });

  it('expires idle sessions', async () => {
    const { email } = await browserSignUp();
    const s = await nativeSignIn(email);
    h.clock.offsetMs = 8 * 86_400_000;
    expect((await h.request('POST', `${base()}/session/refresh`, { body: { refreshToken: s.refreshToken } })).status).toBe(401);
  });

  it('sign-out revokes the session immediately and clears cookies', async () => {
    const { jar } = await browserSignUp();
    const accessCookie = jar.cookies.get('__Host-basalt_at')!;
    const out = await h.request('POST', `${base()}/session/signout`, { origin: ORIGIN, jar, body: {} });
    expect(out.status).toBe(200);
    expect(jar.cookies.size).toBe(0);
    // The clearing headers keep the same flags as the cookies they delete (OWASP ZAP checks every Set-Cookie).
    const cleared = out.headers.getSetCookie();
    expect(cleared.length).toBe(2);
    for (const c of cleared) {
      expect(c).toMatch(/Max-Age=0/);
      expect(c).toMatch(/HttpOnly/);
      expect(c).toMatch(/SameSite=(Lax|Strict)/);
    }
    // The (still unexpired) access token no longer works against strict endpoints.
    expect((await h.request('GET', `${base()}/session`, { bearer: accessCookie })).status).toBe(401);
  });

  it('lists sessions and revokes others', async () => {
    const { jar, email } = await browserSignUp();
    await nativeSignIn(email);
    const other = await nativeSignIn(email);
    const list = (await (await h.request('GET', `${base()}/sessions`, { origin: ORIGIN, jar })).json()) as any;
    expect(list.sessions).toHaveLength(3);
    expect(list.sessions.filter((s: any) => s.current)).toHaveLength(1);
    const r = await h.request('POST', `${base()}/sessions/revoke-others`, { origin: ORIGIN, jar, body: {} });
    expect(((await r.json()) as any).revoked).toBe(2);
    expect((await h.request('GET', `${base()}/session`, { bearer: other.accessToken })).status).toBe(401);
    expect((await h.request('GET', `${base()}/session`, { origin: ORIGIN, jar })).status).toBe(200);
  });

  it('keeps old tokens valid across signing-key rotation', async () => {
    const { email } = await browserSignUp();
    const before = await nativeSignIn(email);
    await h.request('POST', `/v1/platform/projects/${pid}/rotate-signing-key`, { bearer: PLATFORM_KEY, body: {} });
    const after = await nativeSignIn(email);
    expect(decodeProtectedHeader(after.accessToken).kid).not.toBe(decodeProtectedHeader(before.accessToken).kid);
    const jwks = (await (await h.request('GET', `${base()}/.well-known/jwks.json`)).json()) as any;
    expect(jwks.keys).toHaveLength(2);
    expect((await h.request('GET', `${base()}/session`, { bearer: before.accessToken })).status).toBe(200);
    expect((await h.request('GET', `${base()}/session`, { bearer: after.accessToken })).status).toBe(200);
  });
});

describe('password reset', () => {
  it('resets the password, revokes all sessions, and keeps responses identical for unknown emails', async () => {
    const { email } = await browserSignUp();
    const session = await nativeSignIn(email);
    const unknown = await h.request('POST', `${base()}/password/reset/request`, { body: { email: uniqueEmail() } });
    const known = await h.request('POST', `${base()}/password/reset/request`, { body: { email } });
    expect(unknown.status).toBe(202);
    expect(known.status).toBe(202);
    expect(await unknown.json()).toEqual(await known.json());

    const code = await h.lastCode(email);
    const newPassword = 'brand-new-secret-77';
    const res = await h.request('POST', `${base()}/password/reset/confirm`, { body: { email, code, newPassword } });
    expect(res.status).toBe(200);
    expect((await h.request('POST', `${base()}/session/refresh`, { body: { refreshToken: session.refreshToken } })).status).toBe(401);
    expect((await h.request('POST', `${base()}/signin`, { body: { email, password: GOOD_PASSWORD } })).status).toBe(401);
    await nativeSignIn(email, newPassword);
    // Codes are single-use.
    const again = await h.request('POST', `${base()}/password/reset/confirm`, { body: { email, code, newPassword: 'another-secret-88x' } });
    expect(again.status).toBe(400);
    await h.services.accounts.drain();
    expect(h.mailer.outbox.some((m) => m.to === email && m.template === 'password_changed')).toBe(true);
  });

  it('burns the reset code after 5 wrong guesses', async () => {
    const { email } = await browserSignUp();
    await h.request('POST', `${base()}/password/reset/request`, { body: { email } });
    const code = await h.lastCode(email);
    const wrong = code === '123456' ? '654321' : '123456';
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await h.request('POST', `${base()}/password/reset/confirm`, { body: { email, code: wrong, newPassword: 'brand-new-secret-77' } })).status);
    }
    expect(statuses).toEqual([400, 400, 400, 400, 429]);
    const real = await h.request('POST', `${base()}/password/reset/confirm`, { body: { email, code, newPassword: 'brand-new-secret-77' } });
    expect(real.status).toBe(400);
  });

  it('change-password requires the current password and signs out other sessions', async () => {
    const { jar, email } = await browserSignUp();
    const other = await nativeSignIn(email);
    const bad = await h.request('POST', `${base()}/password/change`, { origin: ORIGIN, jar, body: { currentPassword: 'wrong-wrong-wrong', newPassword: 'brand-new-secret-77' } });
    expect(bad.status).toBe(401);
    const ok = await h.request('POST', `${base()}/password/change`, { origin: ORIGIN, jar, body: { currentPassword: GOOD_PASSWORD, newPassword: 'brand-new-secret-77' } });
    expect(ok.status).toBe(200);
    expect((await h.request('GET', `${base()}/session`, { bearer: other.accessToken })).status).toBe(401);
    expect((await h.request('GET', `${base()}/session`, { origin: ORIGIN, jar })).status).toBe(200);
  });
});

describe('multi-factor authentication', () => {
  async function enroll(jar: CookieJar) {
    const { totpCode, currentStep } = await import('../src/lib/totp.js');
    const { base32Decode } = await import('./totp-util.js');
    const e = (await (await h.request('POST', `${base()}/mfa/totp/enroll`, { origin: ORIGIN, jar, body: {} })).json()) as any;
    expect(e.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const secret = base32Decode(e.secret);
    const codeAt = (offsetMs = h.clock.offsetMs) => totpCode(secret, currentStep(Date.now() + offsetMs));
    const c = await h.request('POST', `${base()}/mfa/totp/confirm`, { origin: ORIGIN, jar, body: { code: codeAt() } });
    expect(c.status).toBe(200);
    const { recoveryCodes } = (await c.json()) as any;
    expect(recoveryCodes).toHaveLength(10);
    return { codeAt, recoveryCodes: recoveryCodes as string[] };
  }

  it('requires a second factor at sign-in and rejects TOTP replay', async () => {
    const { jar, email } = await browserSignUp();
    const { codeAt } = await enroll(jar);

    h.clock.offsetMs += 31_000; // move to a fresh TOTP step
    const first = await nativeSignIn(email);
    expect(first.status).toBe('mfa_required');
    expect(first.accessToken).toBeUndefined();
    const code = codeAt();
    const done = await h.request('POST', `${base()}/signin/mfa`, { body: { mfaToken: first.mfaToken, code } });
    expect(done.status).toBe(200);
    const session = (await done.json()) as any;
    expect(session.accessToken).toBeTruthy();

    // Same code again (e.g. phished and replayed) must fail even with a fresh challenge.
    const second = await nativeSignIn(email);
    const replay = await h.request('POST', `${base()}/signin/mfa`, { body: { mfaToken: second.mfaToken, code } });
    expect(replay.status).toBe(400);
    // The MFA token itself is single-use.
    const reuse = await h.request('POST', `${base()}/signin/mfa`, { body: { mfaToken: first.mfaToken, code: codeAt() } });
    expect(reuse.status).toBe(401);
  });

  it('accepts each recovery code exactly once', async () => {
    const { jar, email } = await browserSignUp();
    const { recoveryCodes } = await enroll(jar);
    const c1 = await nativeSignIn(email);
    const ok = await h.request('POST', `${base()}/signin/mfa`, { body: { mfaToken: c1.mfaToken, code: recoveryCodes[0]!.toUpperCase() } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).user.mfaEnabled).toBe(true);
    const c2 = await nativeSignIn(email);
    const again = await h.request('POST', `${base()}/signin/mfa`, { body: { mfaToken: c2.mfaToken, code: recoveryCodes[0] } });
    expect(again.status).toBe(400);
  });

  it('locks the challenge after 5 wrong codes', async () => {
    const { jar, email } = await browserSignUp();
    await enroll(jar);
    const c = await nativeSignIn(email);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await h.request('POST', `${base()}/signin/mfa`, { body: { mfaToken: c.mfaToken, code: '000000' } })).status);
    }
    expect(statuses.slice(0, 4)).toEqual([400, 400, 400, 400]);
    expect(statuses[4]).toBe(429);
    expect(statuses[5]).toBe(401);
  });

  it('password reset does not bypass MFA', async () => {
    const { jar, email } = await browserSignUp();
    await enroll(jar);
    await h.request('POST', `${base()}/password/reset/request`, { body: { email } });
    const code = await h.lastCode(email);
    await h.request('POST', `${base()}/password/reset/confirm`, { body: { email, code, newPassword: 'brand-new-secret-77' } });
    const s = await nativeSignIn(email, 'brand-new-secret-77');
    expect(s.status).toBe('mfa_required');
  });

  it('disabling MFA requires password and a valid code', async () => {
    const { jar } = await browserSignUp();
    const { codeAt } = await enroll(jar);
    h.clock.offsetMs += 31_000;
    const noPw = await h.request('POST', `${base()}/mfa/totp/disable`, { origin: ORIGIN, jar, body: { password: 'wrong-password-1', code: codeAt() } });
    expect(noPw.status).toBe(401);
    const ok = await h.request('POST', `${base()}/mfa/totp/disable`, { origin: ORIGIN, jar, body: { password: GOOD_PASSWORD, code: codeAt() } });
    expect(ok.status).toBe(200);
    const me = (await (await h.request('GET', `${base()}/session`, { origin: ORIGIN, jar })).json()) as any;
    expect(me.user.mfaEnabled).toBe(false);
  });
});

describe('server (secret key) API', () => {
  it('requires the project secret key and refuses browser callers', async () => {
    expect((await h.request('GET', `${base()}/admin/users`)).status).toBe(401);
    const other = await h.createProject();
    expect((await h.request('GET', `${base()}/admin/users`, { bearer: other.secretKey })).status).toBe(401);
    const browser = await h.request('GET', `${base()}/admin/users`, { bearer: secretKey, origin: ORIGIN });
    expect(browser.status).toBe(403);
    expect((await h.request('GET', `${base()}/admin/users`, { bearer: secretKey })).status).toBe(200);
  });

  it('lists, paginates, updates metadata, disables and deletes users', async () => {
    const created = [];
    for (let i = 0; i < 3; i++) created.push((await browserSignUp()).body.user);
    const page1 = (await (await h.request('GET', `${base()}/admin/users?limit=2`, { bearer: secretKey })).json()) as any;
    expect(page1.users).toHaveLength(2);
    const page2 = (await (await h.request('GET', `${base()}/admin/users?limit=2&cursor=${page1.nextCursor}`, { bearer: secretKey })).json()) as any;
    expect(page2.users).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect(JSON.stringify([page1, page2])).not.toMatch(/argon2|password_hash|totp_secret/);

    const target = created[0];
    const patched = await h.request('PATCH', `${base()}/admin/users/${target.id}`, { bearer: secretKey, body: { metadata: { role: 'admin' } } });
    expect(((await patched.json()) as any).user.metadata).toEqual({ role: 'admin' });

    const s = await nativeSignIn(target.email);
    await h.request('PATCH', `${base()}/admin/users/${target.id}`, { bearer: secretKey, body: { disabled: true } });
    expect((await h.request('POST', `${base()}/session/refresh`, { body: { refreshToken: s.refreshToken } })).status).toBe(401);
    const blocked = await h.request('POST', `${base()}/signin`, { body: { email: target.email, password: GOOD_PASSWORD } });
    expect(((await blocked.json()) as any).error.code).toBe('account_disabled');

    expect((await h.request('DELETE', `${base()}/admin/users/${target.id}`, { bearer: secretKey })).status).toBe(204);
    expect((await h.request('GET', `${base()}/admin/users/${target.id}`, { bearer: secretKey })).status).toBe(404);
  });

  it('strictly verifies access tokens against live sessions', async () => {
    const { email } = await browserSignUp();
    const s = await nativeSignIn(email);
    const check = async () => (await (await h.request('POST', `${base()}/admin/sessions/verify`, { bearer: secretKey, body: { accessToken: s.accessToken } })).json()) as any;
    expect((await check()).active).toBe(true);
    await h.request('POST', `${base()}/session/signout`, { body: { refreshToken: s.refreshToken } });
    expect((await check()).active).toBe(false);
  });

  it('records an audit trail', async () => {
    const { body } = await browserSignUp();
    await h.request('POST', `${base()}/signin`, { body: { email: body.user.email, password: 'wrong-password-99' } });
    const res = (await (await h.request('GET', `${base()}/admin/events?userId=${body.user.id}`, { bearer: secretKey })).json()) as any;
    const types = res.events.map((e: any) => e.type);
    expect(types).toEqual(expect.arrayContaining(['user.signed_up', 'user.email_verified', 'user.sign_in_failed']));
  });
});

describe('account deletion', () => {
  it('requires the password and removes the user', async () => {
    const { jar, email } = await browserSignUp();
    expect((await h.request('POST', `${base()}/account/delete`, { origin: ORIGIN, jar, body: { password: 'nope-nope-nope' } })).status).toBe(401);
    expect((await h.request('POST', `${base()}/account/delete`, { origin: ORIGIN, jar, body: { password: GOOD_PASSWORD } })).status).toBe(200);
    expect((await h.request('POST', `${base()}/signin`, { body: { email, password: GOOD_PASSWORD } })).status).toBe(401);
  });
});

describe('HTTP hardening', () => {
  it('sets security headers and no-store on every response', async () => {
    const res = await h.request('GET', `${base()}/config`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('strict-transport-security')).toMatch(/max-age=/);
  });

  it('answers CORS preflight only for allowed origins', async () => {
    const ok = await h.request('OPTIONS', `${base()}/signin`, { origin: ORIGIN });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');
    const bad = await h.request('OPTIONS', `${base()}/signin`, { origin: 'https://evil.example' });
    expect(bad.status).toBe(403);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects oversized bodies', async () => {
    const res = await h.request('POST', `${base()}/signin`, { body: { email: 'a@b.co', password: 'x'.repeat(20_000) } });
    expect(res.status).toBe(413);
  });

  it('returns 404 for unknown projects without leaking details', async () => {
    const res = await h.request('POST', '/v1/projects/prj_doesnotexist123/signin', { body: { email: 'a@b.co', password: 'x' } });
    expect(res.status).toBe(404);
  });
});

describe('platform test users', () => {
  it('creates a verified user through the owner-scoped control plane only', async () => {
    const email = uniqueEmail();
    const res = await h.request('POST', `/v1/platform/projects/${pid}/users`, { bearer: PLATFORM_KEY, body: { email, password: GOOD_PASSWORD } });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).user.emailVerified).toBe(true);
    expect((await h.request('POST', `${base()}/signin`, { body: { email, password: GOOD_PASSWORD } })).status).toBe(200);
    const dupe = await h.request('POST', `/v1/platform/projects/${pid}/users`, { bearer: PLATFORM_KEY, body: { email, password: GOOD_PASSWORD } });
    expect(dupe.status).toBe(409);
    const foreign = await h.request('POST', `/v1/platform/projects/${pid}/users`, { bearer: PLATFORM_KEY, owner: 'ws_other', body: { email: uniqueEmail(), password: GOOD_PASSWORD } });
    expect(foreign.status).toBe(404);
    const weak = await h.request('POST', `/v1/platform/projects/${pid}/users`, { bearer: PLATFORM_KEY, body: { email: uniqueEmail(), password: 'short' } });
    expect(weak.status).toBe(400);
  });
});
