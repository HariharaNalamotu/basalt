import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CookieJar, createHarness, GOOD_PASSWORD, ORIGIN, PLATFORM_KEY, type Harness } from '../../server/test/helpers.js';
import { createAuthClient } from '../src/client.js';
import { BasaltAuthError, createAuthServer, type AuthServer, type PgPoolLike } from '../src/server.js';

const AUTH_URL = 'https://auth.test';
let h: Harness;
let pid: string;
let secretKey: string;
let server: AuthServer;
let appDb: PGlite;
let n = 0;

const serverFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url, AUTH_URL);
  return h.app.request(url.pathname + url.search, init as RequestInit);
};

/** node-postgres-shaped pool over PGlite; `role` mimics connecting as that database user. */
function pool(role: string | null): PgPoolLike {
  return {
    async connect() {
      if (role) await appDb.exec(`SET ROLE ${role}`);
      return {
        async query(sql: string, params: unknown[] = []) {
          const r = await appDb.query(sql, params);
          return { rows: r.rows as any[], rowCount: r.affectedRows ?? null };
        },
        release() {
          void appDb.exec('RESET ROLE');
        },
      };
    },
  };
}

function browser() {
  const jar = new CookieJar();
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if ((init.method ?? 'GET') !== 'GET') headers.set('origin', ORIGIN);
    if (jar.cookies.size) headers.set('cookie', jar.header());
    const res = await serverFetch(input, { ...init, headers });
    jar.absorb(res);
    return res;
  };
  return { jar, client: createAuthClient({ baseUrl: `/v1/projects/${pid}`, fetch: fetchImpl }) };
}

const request = (jar: CookieJar, method = 'GET') =>
  new Request('https://app.example.com/api', { method, headers: { cookie: jar.header(), host: 'app.example.com', ...(method !== 'GET' ? { origin: 'https://app.example.com' } : {}) } });

async function signedUp() {
  const b = browser();
  const email = `data${++n}-${Date.now()}@example.com`;
  const r = await b.client.signUp({ email, password: GOOD_PASSWORD });
  expect(r.status).toBe('signed_in');
  return { ...b, email, userId: (r as any).user.id as string };
}

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  ({ projectId: pid, secretKey } = await h.createProject({ allowedOrigins: [ORIGIN], settings: { requireEmailVerification: false } }));
  h.clock.offsetMs = 0;
  server = createAuthServer({ projectId: pid, authUrl: AUTH_URL, secretKey, fetch: serverFetch });
  appDb = new PGlite();
  await appDb.exec(await (await serverFetch(`/v1/platform/projects/${pid}/data-protection/install.sql`, { headers: { authorization: `Bearer ${PLATFORM_KEY}`, 'x-basalt-owner': 'ws_test' } })).text());
  await appDb.exec(`
    CREATE ROLE app_user NOLOGIN;
    CREATE TABLE notes (id serial PRIMARY KEY, owner_id uuid, body text NOT NULL);
    SELECT basalt_auth.protect('notes');
    GRANT SELECT, INSERT, UPDATE, DELETE ON notes TO app_user;
    GRANT USAGE ON SEQUENCE notes_id_seq TO app_user;
  `);
});

describe('withUserDb', () => {
  it('scopes every query to the signed-in user', async () => {
    const a = await signedUp();
    const b = await signedUp();
    const db = pool('app_user');
    await server.withUserDb(db, request(a.jar, 'POST'), (c) => c.query(`INSERT INTO notes (body) VALUES ('a note')`));
    await server.withUserDb(db, request(b.jar, 'POST'), (c) => c.query(`INSERT INTO notes (body) VALUES ('b note')`));
    // A "forgot the WHERE clause" query still only sees the caller's data.
    const seenByA = await server.withUserDb(db, request(a.jar), async (c) => (await c.query('SELECT owner_id, body FROM notes')).rows);
    expect(seenByA).toEqual([{ owner_id: a.userId, body: 'a note' }]);
  });

  it('rolls back on error and accepts an already-verified user', async () => {
    const a = await signedUp();
    const db = pool('app_user');
    const user = await server.requireUser(request(a.jar));
    await expect(
      server.withUserDb(db, user, async (c) => {
        await c.query(`INSERT INTO notes (body) VALUES ('half done')`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await server.withUserDb(db, user, async (c) => (await c.query('SELECT * FROM notes')).rows)).toEqual([]);
  });

  it('rejects signed-out requests before touching the database', async () => {
    await expect(server.withUserDb(pool('app_user'), new Request('https://app.example.com/'), async () => 1)).rejects.toMatchObject({ status: 401 });
  });

  it('never exposes the grant through the user object', async () => {
    const a = await signedUp();
    const user = await server.requireUser(request(a.jar));
    expect(JSON.stringify(user)).not.toContain(server.dataGrant(user));
    expect(server.dataGrant(user)).toMatch(/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(() => server.dataGrant({ ...user })).toThrow(/no data grant/);
  });

  it('refuses an unsafe (superuser/owner) database role in production', async () => {
    const a = await signedUp();
    const env = (globalThis as any).process.env;
    const prev = env.NODE_ENV;
    env.NODE_ENV = 'production';
    try {
      const prodServer = createAuthServer({ projectId: pid, authUrl: AUTH_URL, fetch: serverFetch });
      await expect(prodServer.withUserDb(pool(null), request(a.jar), async () => 1)).rejects.toThrow(/unsafe database role/);
      expect(await prodServer.withUserDb(pool('app_user'), request(a.jar), async () => 1)).toBe(1);
    } finally {
      env.NODE_ENV = prev;
    }
  });

  it('explains when data protection is not installed', async () => {
    const a = await signedUp();
    const fresh = new PGlite();
    const p: PgPoolLike = { connect: async () => ({ query: async (s: string, v?: unknown[]) => fresh.query(s, v ?? []), release() {} }) as any };
    await expect(server.withUserDb(p, request(a.jar), async () => 1)).rejects.toThrow(/not installed/);
  });

  it('syncs revocations so a signed-out session loses database access immediately', async () => {
    const a = await signedUp();
    const b = await signedUp();
    const db = pool('app_user');
    const stolenCookies = b.jar.header(); // e.g. copied from a shared computer before sign-out
    await b.client.signOut();
    const stale = new Request('https://app.example.com/api', { headers: { cookie: stolenCookies, host: 'app.example.com' } });
    expect(await server.withUserDb(db, stale, async () => 'still works before sync')).toBe('still works before sync');

    const { synced } = await server.syncRevocations(db);
    expect(synced).toBeGreaterThan(0);
    const err = await server.withUserDb(db, stale, async () => 1).catch((e) => e);
    expect(err).toBeInstanceOf(BasaltAuthError);
    expect(err.status).toBe(401);
    expect(await server.withUserDb(db, request(a.jar), async () => 'a fine')).toBe('a fine');
    // Idempotent and incremental.
    expect((await server.syncRevocations(db)).synced).toBeGreaterThanOrEqual(0);
  });
});

describe('step-up re-authentication', () => {
  it('maxAgeSeconds demands a recent sign-in; reauthenticate satisfies it', async () => {
    h.clock.offsetMs = -10 * 60_000; // signed in 10 minutes ago
    const a = await signedUp();
    h.clock.offsetMs = 0;
    const err = await server.requireUser(request(a.jar), { maxAgeSeconds: 300 }).catch((e) => e);
    expect(err.code).toBe('reauthentication_required');
    expect(err.status).toBe(403);

    await a.client.reauthenticate({ password: GOOD_PASSWORD });
    const user = await server.requireUser(request(a.jar), { maxAgeSeconds: 300 });
    expect(user.id).toBe(a.userId);
  });
});
