import { execSync } from 'node:child_process';
// End-to-end checks against the docker compose stack (real Postgres + Redis). Run: docker compose up -d --build && node scripts/e2e.mjs
const BASE = process.env.AUTH_URL ?? 'http://localhost:8787';
const PK = 'dev-only-platform-key-change-me-0123456789';
const ORIGIN = 'http://localhost:5173';
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  -', m); };
const j = async (method, path, body, headers = {}) => {
  const res = await fetch(BASE + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), res };
};
const codeFor = (email) => {
  const logs = execSync('docker compose logs auth --no-log-prefix', { cwd: new URL('..', import.meta.url).pathname }).toString();
  const lines = logs.split('\n').filter((l) => l.includes(email) && l.includes('email.console'));
  return /(\d{6}) is your/.exec(lines.at(-1))?.[1];
};

const p = await j('POST', '/v1/platform/projects', { name: 'E2E', allowedOrigins: [ORIGIN] }, { authorization: `Bearer ${PK}`, 'x-basalt-owner': 'ws_e2e' });
ok(p.status === 201, 'create project on real Postgres');
const base = `/v1/projects/${p.body.project.id}`;
const email = `e2e-${Date.now()}@example.com`;
const pw = 'violet-anchor-58-tundra';

const su = await j('POST', `${base}/signup`, { email, password: pw });
ok(su.status === 202, 'signup pending');
await new Promise((r) => setTimeout(r, 300));
const code = codeFor(email);
ok(/^\d{6}$/.test(code ?? ''), 'verification code delivered via console mailer');
const v = await j('POST', `${base}/signup/verify`, { signupToken: su.body.signupToken, code });
ok(v.status === 201 && v.body.refreshToken, 'verify -> session (native mode)');

const browser = await j('POST', `${base}/signin`, { email, password: pw }, { origin: ORIGIN });
const cookies = browser.res.headers.getSetCookie();
ok(browser.status === 200 && !browser.body.accessToken && cookies.some((c) => c.startsWith('basalt_at=') && /HttpOnly/i.test(c)), 'browser signin sets HttpOnly cookies, no tokens in body');

const r1 = await j('POST', `${base}/session/refresh`, { refreshToken: v.body.refreshToken });
ok(r1.status === 200, 'refresh rotates (bytea/int columns via pg driver)');
await new Promise((r) => setTimeout(r, 10_500));
const replay = await j('POST', `${base}/session/refresh`, { refreshToken: v.body.refreshToken });
const after = await j('POST', `${base}/session/refresh`, { refreshToken: r1.body.refreshToken });
ok(replay.status === 401 && after.status === 401, 'replayed refresh token revokes the session');

const statuses = [];
for (let i = 0; i < 12; i++) statuses.push((await j('POST', `${base}/signin`, { email, password: `wrong-guess-${i}-xyz` })).status);
ok(statuses.slice(10).every((s) => s === 429), `per-account limit enforced via Redis (${statuses.join(',')})`);

const ev = await j('GET', `/v1/platform/projects/${p.body.project.id}/events?limit=200`, undefined, { authorization: `Bearer ${PK}`, 'x-basalt-owner': 'ws_e2e' });
ok(ev.body.events.some((e) => e.type === 'session.refresh_token_reuse'), 'audit log records theft detection (bigserial ids)');
const jwks = await j('GET', `${base}/.well-known/jwks.json`);
ok(jwks.body.keys.length === 1 && jwks.body.keys[0].crv === 'Ed25519' && !('d' in jwks.body.keys[0]), 'JWKS publishes only the public Ed25519 key');
console.log('\nALL E2E CHECKS PASSED');
