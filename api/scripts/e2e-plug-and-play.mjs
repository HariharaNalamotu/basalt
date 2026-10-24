// Plays the role of a coding agent end to end: provisions an app through the real MCP server,
// writes the scaffold it returns (unmodified), runs it behind the dev edge, and checks security and
// HTTP behaviour from a browser's point of view. Requires the auth docker compose stack running.
//   cd auth && docker compose up -d --build --wait && cd ../api && npm run build && node scripts/e2e-plug-and-play.mjs
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, '..');
const authRoot = path.resolve(apiRoot, '../auth');
const appDir = path.join(apiRoot, '.e2e-app');
const APP = `e2e-${Date.now().toString(36)}`;
const EDGE = 'http://localhost:18080';
const BACKEND = 'http://127.0.0.1:13000';
const PG_ADMIN = 'postgres://basalt:basalt@localhost:55432/postgres';
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); cleanup().finally(() => process.exit(1)); throw new Error(m); } console.log('ok  -', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];

rmSync(appDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });

// ---------------------------------------------------------------- the agent's MCP session
const mcp = new Client({ name: 'e2e-agent', version: '0' });
await mcp.connect(new StdioClientTransport({
  command: 'node',
  args: [path.join(apiRoot, 'packages/mcp/dist/stdio.js')],
  env: {
    ...process.env,
    BASALT_AUTH_URL: 'http://localhost:8787',
    BASALT_AUTH_PLATFORM_KEY: 'dev-only-platform-key-change-me-0123456789',
    BASALT_PG_ADMIN_URL: PG_ADMIN,
    BASALT_REDIS_URL: 'redis://localhost:56379',
    BASALT_STATE_DIR: path.join(appDir, '.basalt'),
    BASALT_BACKEND_URL: BACKEND,
    BASALT_OWNER_ID: 'ws_e2e_api',
  },
}));
const tool = async (name, args) => {
  const r = await mcp.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${name}: ${text}`);
  return text;
};

const setup = await tool('api_setup', { app: APP, name: 'E2E Todos', origins: [EDGE] });
ok(/provisioned/.test(setup) && !/bslt_sk_/.test(setup), 'api_setup provisioned everything without revealing secrets');

const scaffoldText = await tool('api_scaffold', { app: APP });
const files = [...scaffoldText.matchAll(/### (\S+)[^\n]*\n```\w*\n([\s\S]*?)\n```/g)];
for (const [, file, content] of files) {
  if (file === 'package.json') {
    const pkg = JSON.parse(content);
    writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: APP, private: true, type: pkg.type, scripts: pkg.scripts }, null, 2));
    continue;
  }
  mkdirSync(path.join(appDir, path.dirname(file)), { recursive: true });
  writeFileSync(path.join(appDir, file), content + '\n');
}
ok(files.length >= 4, `wrote ${files.length} scaffold files exactly as returned`);

const review = await tool('api_review_code', { files: files.filter(([, f]) => /\.(ts|sql)$/.test(f)).map(([, p, content]) => ({ path: p, content })) });
ok(/No issues/.test(review), 'scaffolded code passes api_review_code');

// ---------------------------------------------------------------- run it like the agent would
const envFile = `--env-file=${path.join(appDir, '.basalt', `${APP}.env`)}`;
const bin = (name) => path.join(apiRoot, 'node_modules/@basalt/api/dist', name);
execSync(`node ${envFile} ${bin('migrate-cli.js')} db/migrations`, { cwd: appDir, stdio: 'pipe' });
ok(true, 'migrations applied with the admin role (basalt-migrate)');

async function startBackend() {
  const p = spawn('node', [envFile, 'server/index.ts'], { cwd: appDir, env: { ...process.env, PORT: '13000', NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errOut = '';
  p.stderr.on('data', (d) => (errOut += d));
  procs.push(p);
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${BACKEND}/_basalt/health`).then((r) => r.ok, () => false)) return p;
    await sleep(200);
  }
  throw new Error(`backend did not start: ${errOut}`);
}
const stopBackend = async (p) => {
  p.kill('SIGTERM');
  await new Promise((r) => p.once('exit', r));
};
let backend = await startBackend();
const edge = spawn('node', [envFile, bin('dev-edge-cli.js'), '--port', '18080', '--backend', BACKEND], { cwd: appDir, stdio: 'ignore' });
procs.push(edge);
for (let i = 0; i < 50 && !(await fetch(`${EDGE}/_basalt/health`).then((r) => r.ok, () => false)); i++) await sleep(200);
ok(true, 'backend and dev edge running from the provisioned env file');

// ---------------------------------------------------------------- browser-like flows
function browser() {
  const jar = new Map();
  const setCookies = [];
  const go = async (method, p, body) => {
    const headers = { accept: 'application/json' };
    if (method !== 'GET') headers.origin = EDGE;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(EDGE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      setCookies.push(c);
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const [k, v] = [pair.slice(0, i), pair.slice(i + 1)];
      if (!v || /max-age=0/i.test(c)) jar.delete(k);
      else jar.set(k, v);
    }
    return res;
  };
  return { go, jar, setCookies };
}
const codeFor = (email) => {
  const logs = execSync('docker compose logs auth --no-log-prefix', { cwd: authRoot }).toString();
  return /(\d{6}) is your/.exec(logs.split('\n').filter((l) => l.includes(email)).at(-1) ?? '')?.[1];
};
async function signUp(b) {
  const email = `pnp-${Math.random().toString(36).slice(2)}@example.com`;
  const s = await b.go('POST', '/_basalt/auth/signup', { email, password: 'violet-anchor-58-tundra' });
  const { signupToken } = await s.json();
  await sleep(300);
  const v = await b.go('POST', '/_basalt/auth/signup/verify', { signupToken, code: codeFor(email) });
  return (await v.json()).user;
}

const alice = browser();
const aliceUser = await signUp(alice);
ok(aliceUser?.id && alice.setCookies.some((c) => c.startsWith('basalt_rt=') && /Path=\/_basalt\/auth\/session/.test(c) && /HttpOnly/i.test(c)), 'sign-up through the edge; refresh cookie scoped to /_basalt/auth/session');

ok((await (await alice.go('GET', '/api/todos')).json()).length === 0, 'GET /api/todos -> [] for a new user');
const created = await alice.go('POST', '/api/todos', { title: 'Buy milk' });
const todo = await created.json();
ok(created.status === 201 && todo.title === 'Buy milk' && !('owner_id' in todo) && !('ownerId' in todo), 'POST /api/todos -> 201, internal columns not exposed');

const bob = browser();
await signUp(bob);
ok((await (await bob.go('GET', '/api/todos')).json()).length === 0, "another user's list is empty (database-enforced)");
ok((await bob.go('GET', `/api/todos/${todo.id}`)).status === 404, "another user's todo by id -> 404");
ok((await bob.go('DELETE', `/api/todos/${todo.id}`)).status === 404, "another user cannot delete it -> 404");
ok((await browser().go('GET', '/api/todos')).status === 401, 'signed-out -> 401');
ok((await alice.go('POST', '/api/todos', { title: '' })).status === 422, 'invalid body -> 422');
ok((await alice.go('GET', '/api/todos/not-a-uuid')).status === 400, 'invalid id -> 400');
ok((await alice.go('PUT', '/api/todos', {})).status === 405, 'wrong method -> 405');

const direct = await fetch(`${BACKEND}/api/todos`, { headers: { cookie: [...alice.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
ok(direct.status === 403 && (await direct.json()).error.code === 'direct_access_forbidden', 'direct request to the backend (bypassing the edge) -> 403 even with valid cookies');

alice.jar.delete('basalt_at');
ok((await alice.go('POST', '/_basalt/auth/session/refresh', {})).status === 200 && alice.jar.has('basalt_at'), 'session refresh through the edge');
ok((await alice.go('GET', '/api/todos')).status === 200, 'API works with the refreshed session');

// ---------------------------------------------------------------- operate it through MCP
const statusText = await tool('api_status', { app: APP });
ok(/All checks pass/.test(statusText) && /POST \/api\/todos/.test(statusText), 'api_status: all checks pass and lists live routes with effective policy');

await tool('api_set_route_policy', { app: APP, route: 'POST /todos', policy: { rateLimit: { limit: 2, windowSeconds: 60 } } });
await stopBackend(backend);
backend = await startBackend();
const carol = browser();
await signUp(carol);
const statuses = [];
for (let i = 0; i < 3; i++) statuses.push((await carol.go('POST', '/api/todos', { title: `t${i}` })).status);
ok(statuses.join() === '201,201,429', `route policy set via MCP takes effect (${statuses.join(',')})`);
ok((await alice.go('POST', '/api/todos', { title: 'again' })).status === 429, 'rate limits are shared in Redis and survive a backend restart');

await tool('api_set_maintenance', { app: APP, enabled: true, message: 'Back in 5' });
await stopBackend(backend);
backend = await startBackend();
const m = await alice.go('GET', '/api/todos');
ok(m.status === 503 && m.headers.get('retry-after') === '30', 'maintenance mode via MCP -> 503 + Retry-After');
await tool('api_set_maintenance', { app: APP, enabled: false });

console.log('\nALL PLUG-AND-PLAY E2E CHECKS PASSED');
await cleanup();

async function cleanup() {
  for (const p of procs) p.kill('SIGTERM');
  await mcp.close().catch(() => {});
  const root = new pg.Client({ connectionString: PG_ADMIN });
  await root.connect().catch(() => {});
  const db = `basalt_${APP.replace(/-/g, '_')}`;
  await root.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
  await root.query(`DROP ROLE IF EXISTS ${db}_app`).catch(() => {});
  await root.query(`DROP ROLE IF EXISTS ${db}_admin`).catch(() => {});
  await root.end().catch(() => {});
  rmSync(appDir, { recursive: true, force: true });
}
