import { PGlite } from '@electric-sql/pglite';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, GOOD_PASSWORD, ORIGIN, PLATFORM_KEY, type Harness } from './helpers.js';
import { totpCode, currentStep } from '../src/lib/totp.js';
import { base32Decode } from './totp-util.js';

let h: Harness;
let pid: string;
let secretKey: string;
let appDb: PGlite;
let n = 0;
const base = () => `/v1/projects/${pid}`;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

/** A fresh app database per test, set up the way the platform provisions one. */
beforeEach(async () => {
  ({ projectId: pid, secretKey } = await h.createProject({ settings: { requireEmailVerification: false } }));
  h.clock.offsetMs = 0;
  appDb = new PGlite();
  const sql = await (await h.request('GET', `/v1/platform/projects/${pid}/data-protection/install.sql`, { bearer: PLATFORM_KEY })).text();
  await appDb.exec(sql);
  await appDb.exec(`
    CREATE ROLE app_user NOLOGIN;
    CREATE TABLE todos (id serial PRIMARY KEY, owner_id uuid, title text NOT NULL);
    SELECT basalt_auth.protect('todos');
    GRANT SELECT, INSERT, UPDATE, DELETE ON todos TO app_user;
    GRANT USAGE ON SEQUENCE todos_id_seq TO app_user;
  `);
});

/** Runs SQL exactly as the app's backend would: unprivileged role, grant set for this transaction. */
async function asApp<T = any>(grant: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  return appDb.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE app_user');
    if (grant !== null) await tx.query('SELECT basalt_auth.authenticate($1)', [grant]);
    return (await tx.query<T>(sql, params)).rows;
  });
}

async function signUp(email = `dp${++n}-${Date.now()}@example.com`) {
  const res = await h.request('POST', `${base()}/signup`, { body: { email, password: GOOD_PASSWORD } });
  const body = (await res.json()) as any;
  return { email, userId: body.user.id as string, accessToken: body.accessToken as string, refreshToken: body.refreshToken as string, grant: decodeJwt(body.accessToken).bdg as string };
}

const sqlError = (p: Promise<unknown>) => p.then(() => null, (e: any) => ({ code: e.code as string, message: String(e.message) }));

describe('database-enforced ownership', () => {
  it('every access token carries a session-bound data token in the Data block format', async () => {
    const a = await signUp();
    const claims = decodeJwt(a.accessToken);
    const [h, p, sig] = a.grant.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT', kid: 'v1' });
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    expect(payload).toEqual({ sub: a.userId, sid: claims.sid, iat: expect.any(Number), exp: claims.exp, aud: 'authenticated', role: 'authenticated', iss: `https://auth.test/v1/projects/${pid}` });
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(3600);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(typeof claims.auth_time).toBe('number');
  });

  it('publishes signing config only to the owning workspace', async () => {
    const ok = await h.request('GET', `/v1/platform/projects/${pid}/data-protection/signing`, { bearer: PLATFORM_KEY });
    const body = (await ok.json()) as any;
    expect(body).toMatchObject({ algorithm: 'HS256', keyVersion: 1, issuer: `https://auth.test/v1/projects/${pid}`, maxTokenSeconds: 3600 });
    expect(body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const a = await signUp();
    const { createHmac } = await import('node:crypto');
    const [hh, pp, sig] = a.grant.split('.');
    expect(createHmac('sha256', body.secret).update(`${hh}.${pp}`).digest('base64url')).toBe(sig);
    expect((await h.request('GET', `/v1/platform/projects/${pid}/data-protection/signing`, { bearer: PLATFORM_KEY, owner: 'ws_other' })).status).toBe(404);
  });

  it('returns only the caller\'s rows, even for queries with no WHERE clause', async () => {
    const a = await signUp();
    const b = await signUp();
    await asApp(a.grant, `INSERT INTO todos (title) VALUES ('a1'), ('a2')`);
    await asApp(b.grant, `INSERT INTO todos (title) VALUES ('b1')`);
    expect((await asApp(a.grant, 'SELECT title, owner_id FROM todos ORDER BY title')).map((r) => r.title)).toEqual(['a1', 'a2']);
    expect(await asApp(b.grant, 'SELECT title, owner_id FROM todos')).toEqual([{ title: 'b1', owner_id: b.userId }]);
  });

  it('blocks writing rows owned by someone else, and limits UPDATE/DELETE to own rows', async () => {
    const a = await signUp();
    const b = await signUp();
    await asApp(a.grant, `INSERT INTO todos (title) VALUES ('a1')`);
    await asApp(b.grant, `INSERT INTO todos (title) VALUES ('b1')`);
    const forged = await sqlError(asApp(b.grant, 'INSERT INTO todos (owner_id, title) VALUES ($1, $2)', [a.userId, 'planted']));
    expect(forged?.message).toMatch(/row-level security/);
    await asApp(b.grant, `UPDATE todos SET title = 'pwned'`);
    await asApp(b.grant, `DELETE FROM todos WHERE true`);
    expect(await asApp(a.grant, 'SELECT title FROM todos')).toEqual([{ title: 'a1' }]);
    const steal = await sqlError(asApp(b.grant, 'UPDATE todos SET owner_id = $1', [b.userId]));
    expect(steal).toBeNull(); // affects only b's (now deleted) rows: nothing to steal
    expect(await asApp(a.grant, 'SELECT owner_id FROM todos')).toEqual([{ owner_id: a.userId }]);
  });

  it('fails closed: no grant means no rows and no writes', async () => {
    const a = await signUp();
    await asApp(a.grant, `INSERT INTO todos (title) VALUES ('secret')`);
    expect(await asApp(null, 'SELECT * FROM todos')).toEqual([]);
    expect(await sqlError(asApp(null, `INSERT INTO todos (title) VALUES ('x')`))).not.toBeNull();
  });

  it('rejects tampered, forged-signature, expired and foreign-project grants', async () => {
    const a = await signUp();
    const b = await signUp();
    const [hb, pb, sb] = b.grant.split('.');
    const payload = JSON.parse(Buffer.from(pb!, 'base64url').toString());
    const impersonate = `${hb}.${Buffer.from(JSON.stringify({ ...payload, sub: a.userId })).toString('base64url')}.${sb}`;
    const badSig = `${hb}.${pb}.${'A'.repeat(43)}`;
    const noneAlg = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', kid: 'v1' })).toString('base64url')}.${pb}.${sb}`;
    const nonCanonical = `${hb}.${pb}.${sb!.slice(0, 42)}${sb!.endsWith('A') ? 'B' : 'A'}`;
    for (const g of [impersonate, badSig, noneAlg, nonCanonical, 'garbage', `${b.grant}x`]) {
      const err = await sqlError(asApp(g, 'SELECT 1'));
      expect(err?.code, g.slice(0, 40)).toBe('28000');
    }

    h.clock.offsetMs = -2 * 3600_000; // grant minted two hours ago has expired
    const old = await signUp();
    expect((await sqlError(asApp(old.grant, 'SELECT 1')))?.message).toMatch(/expired/);
    h.clock.offsetMs = 0;

    const other = await h.createProject({ settings: { requireEmailVerification: false } });
    const res = await h.request('POST', `/v1/projects/${other.projectId}/signup`, { body: { email: 'x@example.com', password: GOOD_PASSWORD } });
    const foreign = decodeJwt(((await res.json()) as any).accessToken).bdg as string;
    expect((await sqlError(asApp(foreign, 'SELECT 1')))?.message).toMatch(/another project/);
  });

  it('cuts off data access for revoked sessions once revocations are synced', async () => {
    const a = await signUp();
    const b = await signUp();
    await asApp(b.grant, `INSERT INTO todos (title) VALUES ('b1')`);
    await h.request('POST', `${base()}/session/signout`, { body: { refreshToken: b.refreshToken } });

    const feed = (await (await h.request('GET', `${base()}/admin/revocations`, { bearer: secretKey })).json()) as any;
    const sessionB = decodeJwt(b.accessToken).sid;
    expect(feed.revocations.map((r: any) => r.sessionId)).toContain(sessionB);
    await asApp(null, 'SELECT basalt_auth.record_revocations($1::uuid[], $2::timestamptz[], now())', [
      feed.revocations.map((r: any) => r.sessionId),
      feed.revocations.map((r: any) => r.revokedAt),
    ]);

    expect((await sqlError(asApp(b.grant, 'SELECT * FROM todos')))?.message).toMatch(/revoked/);
    expect(await asApp(a.grant, 'SELECT * FROM todos')).toEqual([]); // others unaffected
  });

  it('records revocations for every way a session can end (trigger-based, no path can forget)', async () => {
    const sid = (u: { accessToken: string }) => decodeJwt(u.accessToken).sid as string;
    const disabled = await signUp();
    const deleted = await signUp();
    const passwordChanged = await signUp();
    const other = await h.request('POST', `${base()}/signin`, { body: { email: passwordChanged.email, password: GOOD_PASSWORD } });
    const otherSid = decodeJwt(((await other.json()) as any).accessToken).sid as string;

    await h.request('PATCH', `${base()}/admin/users/${disabled.userId}`, { bearer: secretKey, body: { disabled: true } });
    await h.request('DELETE', `${base()}/admin/users/${deleted.userId}`, { bearer: secretKey });
    await h.request('POST', `${base()}/password/change`, {
      bearer: passwordChanged.accessToken,
      body: { currentPassword: GOOD_PASSWORD, newPassword: 'brand-new-secret-77' },
    });

    const feed = (await (await h.request('GET', `${base()}/admin/revocations`, { bearer: secretKey })).json()) as any;
    const ids = feed.revocations.map((r: any) => r.sessionId);
    expect(ids).toEqual(expect.arrayContaining([sid(disabled), sid(deleted), otherSid]));
    expect(ids).not.toContain(sid(passwordChanged)); // the session that changed the password stays valid

    // Cursor pagination: nothing new after the last item.
    const next = (await (await h.request('GET', `${base()}/admin/revocations?cursor=${feed.nextCursor}`, { bearer: secretKey })).json()) as any;
    expect(next.revocations).toEqual([]);
  });

  it('keeps the key out of reach of the app role', async () => {
    const keys = await sqlError(asApp(null, 'SELECT * FROM basalt_auth.keys'));
    expect(keys?.message).toMatch(/permission denied/);
    const revoked = await sqlError(asApp(null, 'DELETE FROM basalt_auth.revoked_sessions'));
    expect(revoked?.message).toMatch(/permission denied/);
    const disable = await sqlError(asApp(null, 'ALTER TABLE todos DISABLE ROW LEVEL SECURITY'));
    expect(disable?.message).toMatch(/must be owner/);
    // The install SQL is only available to the owning workspace.
    const foreign = await h.request('GET', `/v1/platform/projects/${pid}/data-protection/install.sql`, { bearer: PLATFORM_KEY, owner: 'ws_other' });
    expect(foreign.status).toBe(404);
  });

  it('protect() validates the owner column and unprotected_tables() finds forgotten tables', async () => {
    await appDb.exec(`CREATE TABLE notes (id serial, user_id uuid, body text); CREATE TABLE bad (owner_id text);`);
    const listed = (await appDb.query<{ table_name: string }>(`SELECT table_name FROM basalt_auth.unprotected_tables()`)).rows.map((r) => r.table_name);
    expect(listed).toEqual(expect.arrayContaining(['public.notes', 'public.bad']));
    expect(listed).not.toContain('public.todos');
    expect((await sqlError(appDb.query(`SELECT basalt_auth.protect('bad')`)))?.message).toMatch(/must be uuid/);
    await appDb.query(`SELECT basalt_auth.protect('notes', 'user_id')`);
    const remaining = (await appDb.query<{ table_name: string }>(`SELECT table_name FROM basalt_auth.unprotected_tables()`)).rows.map((r) => r.table_name);
    expect(remaining).not.toContain('public.notes');
  });

  it('install is idempotent', async () => {
    const sql = await (await h.request('GET', `/v1/platform/projects/${pid}/data-protection/install.sql`, { bearer: PLATFORM_KEY })).text();
    await appDb.exec(sql);
    const a = await signUp();
    await asApp(a.grant, `INSERT INTO todos (title) VALUES ('still works')`);
    expect(await asApp(a.grant, 'SELECT title FROM todos')).toEqual([{ title: 'still works' }]);
  });
});

describe('step-up re-authentication', () => {
  it('refreshes auth_time after the password is re-entered', async () => {
    const a = await signUp();
    const before = decodeJwt(a.accessToken).auth_time as number;
    // Within the verifier's 60s clock-skew tolerance (tokens "issued in the future" are rejected).
    h.clock.offsetMs = 50_000;
    const bad = await h.request('POST', `${base()}/session/reauthenticate`, { bearer: a.accessToken, body: { password: 'wrong-password-1' } });
    expect(bad.status).toBe(401);
    const res = await h.request('POST', `${base()}/session/reauthenticate`, { bearer: a.accessToken, body: { password: GOOD_PASSWORD } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const after = decodeJwt(body.accessToken);
    expect((after.auth_time as number) - before).toBeGreaterThanOrEqual(50);
    expect(after.sid).toBe(decodeJwt(a.accessToken).sid); // same session, new proof
    // The new token's grant works in the app database.
    await asApp(after.bdg as string, `INSERT INTO todos (title) VALUES ('after step-up')`);
  });

  it('requires the second factor when MFA is enabled', async () => {
    const a = await signUp();
    const enroll = (await (await h.request('POST', `${base()}/mfa/totp/enroll`, { bearer: a.accessToken, body: {} })).json()) as any;
    const secret = base32Decode(enroll.secret);
    await h.request('POST', `${base()}/mfa/totp/confirm`, { bearer: a.accessToken, body: { code: totpCode(secret, currentStep()) } });
    const noCode = await h.request('POST', `${base()}/session/reauthenticate`, { bearer: a.accessToken, body: { password: GOOD_PASSWORD } });
    expect(((await noCode.json()) as any).error.code).toBe('mfa_required');
    h.clock.offsetMs = 31_000;
    const ok = await h.request('POST', `${base()}/session/reauthenticate`, {
      bearer: a.accessToken,
      body: { password: GOOD_PASSWORD, code: totpCode(secret, currentStep(Date.now() + 31_000)) },
    });
    expect(ok.status).toBe(200);
    expect(decodeJwt(((await ok.json()) as any).accessToken).amr).toEqual(['pwd', 'otp']);
  });

  it('sets only the access cookie for browsers', async () => {
    const a = await signUp();
    const res = await h.request('POST', `${base()}/session/reauthenticate`, { origin: ORIGIN, bearer: a.accessToken, body: { password: GOOD_PASSWORD } });
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('__Host-basalt_at='))).toBe(true);
    expect(cookies.some((c) => c.startsWith('__Secure-basalt_rt='))).toBe(false);
    expect(((await res.json()) as any).accessToken).toBeUndefined();
  });
});
