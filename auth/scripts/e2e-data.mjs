// End-to-end check of database-enforced ownership on real Postgres with a real restricted login role,
// using the built SDK and node-postgres. Run after: docker compose up -d --build && npm run build
import pg from 'pg';
import { createAuthServer } from '../packages/sdk/dist/server.js';

const AUTH = process.env.AUTH_URL ?? 'http://localhost:8787';
const PG_ADMIN = process.env.PG_ADMIN_URL ?? 'postgres://basalt:basalt@localhost:55432/postgres';
const PK = 'dev-only-platform-key-change-me-0123456789';
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  -', m); };
const call = async (method, path, body, headers = {}) => {
  const res = await fetch(AUTH + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return res;
};
const platform = { authorization: `Bearer ${PK}`, 'x-basalt-owner': 'ws_e2e_data' };

const created = await (await call('POST', '/v1/platform/projects', { name: 'Data E2E', settings: { requireEmailVerification: false } }, platform)).json();
const pid = created.project.id;
const installSql = await (await call('GET', `/v1/platform/projects/${pid}/data-protection/install.sql`, undefined, platform)).text();

// Provision an app database the way the platform would: admin installs, app gets a restricted login role.
const dbName = `app_e2e_${Date.now()}`;
const root = new pg.Client({ connectionString: PG_ADMIN });
await root.connect();
await root.query(`CREATE DATABASE ${dbName}`);
await root.query(`DROP ROLE IF EXISTS app_e2e`);
await root.query(`CREATE ROLE app_e2e LOGIN PASSWORD 'app_e2e_pw'`);
const adminUrl = PG_ADMIN.replace(/\/[^/]*$/, `/${dbName}`);
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(installSql);
await admin.query(`
  CREATE TABLE todos (id bigserial PRIMARY KEY, owner_id uuid, title text NOT NULL);
  SELECT basalt_auth.protect('todos');
  GRANT USAGE ON SCHEMA public TO app_e2e;
  GRANT SELECT, INSERT, UPDATE, DELETE ON todos TO app_e2e;
  GRANT USAGE ON SEQUENCE todos_id_seq TO app_e2e;
`);
ok(true, 'installed verifier into a separate app database (real Postgres)');

const appUrl = adminUrl.replace('basalt:basalt@', 'app_e2e:app_e2e_pw@');
const pool = new pg.Pool({ connectionString: appUrl, max: 4 });
const adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });
const auth = createAuthServer({ projectId: pid, authUrl: AUTH, secretKey: created.secretKey });

const signUp = async (email) => (await (await call('POST', `/v1/projects/${pid}/signup`, { email, password: 'violet-anchor-58-tundra' })).json());
const a = await signUp(`a-${Date.now()}@example.com`);
const b = await signUp(`b-${Date.now()}@example.com`);
const req = (u) => new Request('https://app.example.com/api', { headers: { authorization: `Bearer ${u.accessToken}` } });

await auth.withUserDb(pool, req(a), (db) => db.query(`INSERT INTO todos (title) VALUES ('a1'), ('a2')`));
await auth.withUserDb(pool, req(b), (db) => db.query(`INSERT INTO todos (title) VALUES ('b1')`));
const seenA = await auth.withUserDb(pool, req(a), async (db) => (await db.query('SELECT owner_id, title FROM todos ORDER BY id')).rows);
ok(seenA.length === 2 && seenA.every((r) => r.owner_id === a.user.id), 'unfiltered SELECT returns only the caller\'s rows');

const forged = await auth.withUserDb(pool, req(b), (db) => db.query('INSERT INTO todos (owner_id, title) VALUES ($1, $2)', [a.user.id, 'planted'])).then(() => null, (e) => e);
ok(/row-level security/.test(forged?.message ?? ''), 'writing a row owned by another user is rejected by Postgres');

const direct = await pool.query('SELECT count(*)::int AS n FROM todos');
ok(direct.rows[0].n === 0, 'app role without a grant sees zero rows (fail-closed)');
const keyRead = await pool.query('SELECT * FROM basalt_auth.keys').then(() => null, (e) => e);
ok(/permission denied/.test(keyRead?.message ?? ''), 'app role cannot read the grant key');

await call('POST', `/v1/projects/${pid}/session/signout`, { refreshToken: b.refreshToken });
const { synced } = await auth.syncRevocations(pool);
const afterSignout = await auth.withUserDb(pool, req(b), async () => 'leak').then(() => null, (e) => e);
ok(synced > 0 && afterSignout?.status === 401, 'signed-out session loses database access after revocation sync');

process.env.NODE_ENV = 'production';
const prodAuth = createAuthServer({ projectId: pid, authUrl: AUTH });
const unsafe = await prodAuth.withUserDb(adminPool, req(a), async () => 1).then(() => null, (e) => e);
ok(/unsafe database role/.test(unsafe?.message ?? ''), 'SDK refuses to run against the owner/admin role in production');

await pool.end();
await adminPool.end();
await admin.end();
await root.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
await root.query(`DROP ROLE app_e2e`);
await root.end();
console.log('\nALL DATA-PROTECTION E2E CHECKS PASSED');
