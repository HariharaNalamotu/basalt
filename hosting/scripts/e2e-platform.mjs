// End-to-end: a coding agent builds, tests, stages and ships an app on a running Basalt Host,
// using ONLY the MCP tools (through the real local MCP client), then the platform's security
// properties are checked from the outside.
//   cd hosting/deploy && docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
//   node hosting/scripts/e2e-platform.mjs
import http from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { scaffold } from '../../api/packages/mcp/dist/scaffold.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const envFile = Object.fromEntries(readFileSync(path.join(root, 'deploy/.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const ROOT = envFile.ROOT_DOMAIN;
// The local stack serves apps over http on :8080 (docker-compose.local.yml); that's what browsers send as Origin.
const PUBLIC = (host) => `http://${host}:8080`;
const APP = `todo${Date.now().toString(36).slice(-5)}`;
const appDir = path.join(root, '.e2e', APP);
const ok = (c, m) => {
  if (!c) throw new Error(m);
  console.log('ok  -', m);
};
const t0 = Date.now();
const elapsed = () => `${Math.round((Date.now() - t0) / 1000)}s`;

// ---------------------------------------------------------------------------- the app
rmSync(appDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });
const files = scaffold(APP);
const write = (rel, content) => {
  mkdirSync(path.dirname(path.join(appDir, rel)), { recursive: true });
  writeFileSync(path.join(appDir, rel), content);
};
write('server/routes/todos.ts', files['server/routes/todos.ts']);
write('db/migrations/001_todos.sql', files['db/migrations/001_todos.sql']);
write(
  'server/index.ts',
  `import { createApi, z } from '@basalt/api';
import { serve } from '@basalt/api/serve';
import { registerTodoRoutes } from './routes/todos.ts';

const api = createApi();
registerTodoRoutes(api);

// Probe of the sandbox's network policy (used by the platform end-to-end test).
api.get('/probe', { auth: 'public', response: z.object({ metadata: z.string(), platformDb: z.string(), internet: z.string(), secret: z.boolean() }) }, async () => {
  const attempt = async (url: string) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      return 'reachable:' + r.status;
    } catch (e) {
      return 'blocked:' + String((e as Error).cause ?? (e as Error).message).slice(0, 80);
    }
  };
  return {
    metadata: await attempt('http://169.254.169.254/latest/meta-data/'),
    platformDb: await attempt('http://basalt-control:4001/internal/routes'),
    internet: await attempt('https://example.com/'),
    secret: process.env.E2E_SECRET === 'sesame',
  };
});

serve(api);
`,
);
write(
  'package.json',
  JSON.stringify(
    {
      name: APP,
      private: true,
      type: 'module',
      scripts: { build: 'node build.mjs' },
      dependencies: { '@basalt/api': '^0.1.0', '@basalt/auth': '^0.1.0' },
      devDependencies: { '@playwright/test': '~1.64.0' },
    },
    null,
    2,
  ),
);
write(
  'build.mjs',
  `import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/assets', { recursive: true });
const js = readFileSync('src/app.js');
const name = 'app-' + createHash('sha256').update(js).digest('hex').slice(0, 10) + '.js';
writeFileSync('dist/assets/' + name, js);
writeFileSync('dist/index.html', readFileSync('src/index.html', 'utf8').replace('/app.js', '/assets/' + name));
`,
);
write(
  'src/index.html',
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Todos</title></head>
<body><main>
  <h1 id="heading">Sign in</h1>
  <form id="signin"><label>Email <input id="email" type="email" autocomplete="email"></label>
  <label>Password <input id="password" type="password" autocomplete="current-password"></label>
  <button type="submit">Sign in</button></form>
  <section id="app" hidden>
    <form id="add"><input id="title" placeholder="What needs doing?"><button type="submit">Add</button></form>
    <ul id="list" aria-label="todos"></ul>
  </section>
  <p id="error" role="alert"></p>
</main><script type="module" src="/app.js"></script></body></html>`,
);
write(
  'src/app.js',
  `const $ = (id) => document.getElementById(id);
async function load() {
  const r = await fetch('/api/todos', { credentials: 'same-origin' });
  if (!r.ok) return;
  $('signin').hidden = true; $('app').hidden = false; $('heading').textContent = 'Your todos';
  $('list').replaceChildren(...(await r.json()).map((t) => Object.assign(document.createElement('li'), { textContent: t.title })));
}
$('signin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/_basalt/auth/signin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('email').value, password: $('password').value }) });
  if (!r.ok) { $('error').textContent = (await r.json()).error.message; return; }
  await load();
});
$('add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/api/todos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: $('title').value }) });
  if (r.ok) { $('title').value = ''; await load(); } else $('error').textContent = (await r.json()).error.message;
});
load();
`,
);
write(
  'e2e/todos.spec.ts',
  `import { test, expect } from '@playwright/test';

test('a signed-in user can add a todo', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill(process.env.TEST_USER_EMAIL!);
  await page.getByLabel('Password').fill(process.env.TEST_USER_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your todos' })).toBeVisible();
  await page.getByPlaceholder('What needs doing?').fill('Buy milk');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Buy milk')).toBeVisible();
});

test('signed-out API calls are rejected', async ({ request }) => {
  expect((await request.get('/api/todos')).status()).toBe(401);
});
`,
);

// ---------------------------------------------------------------------------- the agent
const mcp = new Client({ name: 'e2e-agent', version: '0' });
await mcp.connect(
  new StdioClientTransport({
    command: 'node',
    args: [path.join(root, 'packages/mcp/dist/main.js')],
    env: { ...process.env, BASALT_HOST_URL: 'http://127.0.0.1:4000', BASALT_HOST_TOKEN: process.env.BASALT_HOST_TOKEN, BASALT_ROOT_DOMAIN: ROOT, BASALT_PROJECT_DIR: appDir },
  }),
);
const tool = async (name, args = {}) => {
  const r = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${name}: ${text}`);
  return { text, content: r.content };
};

// Deleting an app needs the owner: host_delete_app only asks, then the owner taps Confirm in the
// dashboard. The test plays the owner through the dashboard link the tool returns.
const deleteApp = async (app) => {
  const asked = await tool('host_delete_app', { app });
  const link = /https?:\/\/\S+\/dashboard\/open\?t=\S+/.exec(asked.text)?.[0];
  if (!link) throw new Error(`host_delete_app gave no dashboard link: ${asked.text}`);
  const open = await fetch(link, { redirect: 'manual' });
  const cookie = (open.headers.get('set-cookie') ?? '').split(';')[0];
  const res = await fetch(new URL('/dashboard/api/delete-app', link), { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-basalt-dashboard': '1' }, body: JSON.stringify({ app }), signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`owner confirm failed: ${res.status} ${await res.text()}`);
  return `Deleted app ${app}.`;
};
const waitDone = async (depId) => {
  for (;;) {
    const r = await tool('host_wait', { deploymentId: depId });
    const s = JSON.parse(r.text.slice(r.text.indexOf('{')));
    if (s.done) return s;
    process.stdout.write(`    … ${s.status} / ${s.pipelines.map((p) => `${p.target}:${p.stage}`).join(', ')} (${elapsed()})\n`);
  }
};

/** Request through the public edge listener with a Host header (what Cloudflare forwards). */
function edge(host, p, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 8080, path: p, method, headers: { host, ...headers } }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let failed = false;
try {
  if (process.env.E2E_QUICK) {
    await tool('host_create_app', { app: APP });
    const d = await tool('host_deploy', { app: APP });
    await waitDone(/"deploymentId": "(dep_[a-z0-9]+)"/.exec(d.text)[1]);
    const t = Date.now();
    await deleteApp(APP);
    console.log(`quick: deleted in ${Date.now() - t}ms`);
    process.exit(0);
  }
  const tools = (await mcp.listTools()).tools.map((t) => t.name);
  ok(['host_deploy', 'host_init', 'host_promote', 'browser_open', 'browser_click', 'api_review_code', 'auth_integration_guide'].every((t) => tools.includes(t)), `agent sees ${tools.length} tools (local + remote)`);

  await tool('host_create_app', { app: APP });
  const init = await tool('host_init', {});
  ok(/basalt\.json/.test(init.text), 'host_init prepared the project');

  console.log(`  deploying ${APP} (build → preview → smoke + e2e)…`);
  const dep = await tool('host_deploy', { app: APP, message: 'first version' });
  const depId = /"deploymentId": "(dep_[a-z0-9]+)"/.exec(dep.text)?.[1];
  ok(Boolean(depId), `host_deploy started ${depId}`);
  const s1 = await waitDone(depId);
  const preview = s1.liveIn.find((e) => e.env.startsWith('p'));
  const stepNames = s1.steps.map((x) => `${x.name}:${x.status}`).join(' ');
  if (s1.pipelines[0].status !== 'passed') console.log(JSON.stringify(s1, null, 2).slice(0, 8000));
  ok(s1.status === 'built' && s1.pipelines[0].status === 'passed', `CI + preview pipeline passed in ${elapsed()} (${stepNames})`);
  ok(s1.tests.some((t) => t.kind === 'e2e' && t.status === 'passed' && t.summary.passed === 2), 'app e2e tests passed against the preview (2/2)');
  const previewHost = new URL(preview.url).hostname;

  // Private preview: closed to the public, open to the agent's tools.
  const anon = await edge(previewHost, '/', { headers: { accept: 'text/html' } });
  ok(anon.status === 401 && /noindex/.test(anon.headers['x-robots-tag']), 'preview is private to the public (401, noindex)');
  const share = (await tool('host_share_link', { app: APP, env: preview.env, ttlMinutes: 10 })).text.trim();
  const viaLink = await edge(previewHost, new URL(share).pathname + new URL(share).search);
  ok(viaLink.status === 303 && /basalt_access=/.test(viaLink.headers['set-cookie']), 'share link grants a human access');

  // The agent drives the site in a real browser.
  const creds = JSON.parse((await tool('host_test_user', { app: APP, env: preview.env })).text);
  const opened = await tool('browser_open', { app: APP, env: preview.env });
  const sessionId = /sessionId: ([0-9a-f-]{36})/.exec(opened.text)[1];
  ok(/heading "Sign in"/.test(opened.text), 'browser_open shows the page snapshot');
  await tool('browser_fill', { session: sessionId, target: { label: 'Email' }, value: creds.email });
  await tool('browser_fill', { session: sessionId, target: { label: 'Password' }, value: creds.password });
  const signedIn = await tool('browser_click', { session: sessionId, target: { role: 'button', name: 'Sign in' } });
  await tool('browser_wait_for', { session: sessionId, text: 'Your todos' });
  await tool('browser_fill', { session: sessionId, target: { placeholder: 'What needs doing?' }, value: 'Ship it' });
  await tool('browser_click', { session: sessionId, target: { role: 'button', name: 'Add' } });
  const after = await tool('browser_wait_for', { session: sessionId, text: 'Ship it' });
  ok(/Ship it/.test(after.text), 'agent signed in and added a todo through the browser');
  const shot = await tool('browser_screenshot', { session: sessionId });
  ok(shot.content.some((c) => c.type === 'image' && c.data.length > 1000), 'browser_screenshot returns an image the agent can see');
  const net = await tool('browser_network', { session: sessionId });
  ok(!/"status": 5\d\d/.test(net.text), 'no server errors seen by the page');
  await tool('browser_close', { session: sessionId });
  void signedIn;

  // The Data block on the app's own site: rules set by the agent, enforced in Postgres per user,
  // reached with only the session cookie (no token in page code).
  const access = new URL(share).searchParams.get('t');
  const rules = await tool('host_data_rules', { app: APP, env: preview.env, rules: { tables: { notes: { fields: { text: { type: 'text', required: true, maxLength: 200 } } } } } });
  ok(/^Live/.test(rules.text), 'host_data_rules: preview rules go live right away');
  const origin = PUBLIC(previewHost);
  const signInCookie = async (c) => {
    const r = await edge(previewHost, '/_basalt/auth/signin', { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-basalt-access': access }, body: JSON.stringify({ email: c.email, password: c.password }) });
    const cookie = [].concat(r.headers['set-cookie'] ?? []).find((x) => x.startsWith('__Host-basalt_at='));
    if (r.status !== 200 || !cookie) throw new Error(`sign in failed: ${r.status} ${r.body}`);
    return cookie.split(';')[0];
  };
  const dataCall = (cookie, op, body, from = origin) =>
    edge(previewHost, `/_basalt/data/v1/data/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: from, 'x-basalt-access': access, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }).then((r) => ({ status: r.status, body: JSON.parse(r.body || '{}') }));
  const aliceCookie = await signInCookie(creds);
  const bobCookie = await signInCookie(JSON.parse((await tool('host_test_user', { app: APP, env: preview.env })).text));
  const note = await dataCall(aliceCookie, 'create', { table: 'notes', input: { text: 'alice only' } });
  ok(note.status === 200 && note.body.data?.text === 'alice only', `signed-in user saves through /_basalt/data with only the cookie (${note.status})`);
  const aliceList = await dataCall(aliceCookie, 'list', { table: 'notes' });
  const bobList = await dataCall(bobCookie, 'list', { table: 'notes' });
  ok(aliceList.body.data.rows.length === 1 && bobList.body.data.rows.length === 0, 'each person only sees their own rows (enforced in Postgres)');
  ok((await dataCall(bobCookie, 'get', { table: 'notes', id: note.body.data.id })).status === 404, "another person can't read the row by id");
  ok((await dataCall(bobCookie, 'update', { table: 'notes', id: note.body.data.id, input: { text: 'pwned' } })).status === 404, "another person can't change it");
  ok((await dataCall(aliceCookie, 'list', { table: 'notes' }, 'https://evil.example')).status === 401, 'cross-site use of the cookie is refused (CSRF)');
  ok((await dataCall(null, 'list', { table: 'notes' })).status === 401, 'no login, no data');

  // The rest of the data toolkit through the same connector: guide, status, admin, Guard.
  ok(/_basalt\/data/.test((await tool('host_guide', { topic: 'data' })).text), 'host_guide "data" explains the Data block');
  const dstatus = await tool('host_data_status', { app: APP, env: preview.env });
  ok(/^Live/.test(dstatus.text) && dstatus.text.includes(`${PUBLIC(`cloud.${ROOT}`)}/owner/`), "host_data_status: rules in plain English and the owner's data map link");
  const mapPath = new URL(/(http\S+\/owner\/\S+)/.exec(dstatus.text)[1]);
  ok((await edge(`cloud.${ROOT}`, mapPath.pathname + mapPath.search)).status === 200, "the owner's data map opens through the edge");
  const admin = await tool('host_data_admin', { app: APP, env: preview.env, who: 'owner' });
  ok(/\/approve\//.test(admin.text), 'host_data_admin always asks the owner to approve');
  write('src/cart.js', "export const save = (cart) => localStorage.setItem('cart', JSON.stringify(cart));\n");
  const check = await tool('host_data_check', { app: APP, env: preview.env });
  rmSync(path.join(appDir, 'src/cart.js'));
  const [, passed, total] = /(\d+) of (\d+) checks passed/.exec(check.text) ?? [];
  ok(Number(total) >= 10 && passed === total, `Guard: ${passed} of ${total} attacks on the preview's data were refused`);
  ok(/src\/cart\.js, line 1/.test(check.text), 'Guard: the local scan found data kept in browser storage');
  const receipt = new URL(/(http\S+\/check\?k=\S+)/.exec(check.text)[1]);
  const receiptPage = await edge(`cloud.${ROOT}`, receipt.pathname + receipt.search);
  ok(receiptPage.status === 200 && /<html/i.test(receiptPage.body), "the owner's safety receipt opens");

  // Sandbox network policy, from inside the running backend.
  const probe = JSON.parse((await edge(previewHost, '/api/probe', { headers: { 'x-basalt-access': new URL(share).searchParams.get('t') } })).body);
  ok(probe.metadata.startsWith('blocked'), `backend cannot reach cloud metadata (${probe.metadata})`);
  ok(probe.platformDb.startsWith('blocked'), `backend cannot reach the platform's internal services (${probe.platformDb})`);
  ok(probe.internet.startsWith('reachable'), `backend can reach the public internet through the egress proxy (${probe.internet})`);

  // Stage and ship.
  console.log('  promoting to staging…');
  const st = await tool('host_promote', { app: APP, deploymentId: depId, to: 'staging' });
  ok(/staging/.test(st.text), 'promoted to staging');
  const s2 = await waitDone(depId);
  ok(s2.pipelines.find((p) => p.target === 'staging')?.status === 'passed', `staging tests passed (${elapsed()})`);

  console.log('  shipping to production…');
  const prod = JSON.parse((await tool('host_promote', { app: APP, deploymentId: depId, to: 'production' })).text);
  ok(prod.url === PUBLIC(`${APP}.${ROOT}`), `live in production at ${prod.url}`);
  const prodHost = `${APP}.${ROOT}`;
  const home = await edge(prodHost, '/', { headers: { accept: 'text/html', 'accept-encoding': 'br' } });
  ok(home.status === 200 && /default-src 'self'/.test(home.headers['content-security-policy']) && /max-age/.test(home.headers['strict-transport-security']), 'production serves the app publicly with CSP and HSTS');
  ok((await edge(prodHost, '/api/todos')).status === 401, 'production API requires sign-in');
  ok((await edge(prodHost, '/_basalt/introspect')).status === 404, 'backend internals are not reachable publicly');
  ok((await edge(prodHost, '/.env')).status === 404 && (await edge(prodHost, '/wp-login.php')).status === 404, 'scanner probes get nothing');
  const prodRules = await tool('host_data_rules', { app: APP, env: 'production', rules: { tables: { notes: { fields: { text: { type: 'text', required: true, maxLength: 200 } } } } } });
  ok(/Waiting for the owner/.test(prodRules.text) && /\/approve\//.test(prodRules.text), 'production data rules wait for the human owner to approve');

  // Operate it.
  await tool('host_set_secret', { app: APP, env: 'production', name: 'E2E_SECRET', value: 'sesame' });
  const probe2 = JSON.parse((await edge(prodHost, '/api/probe')).body);
  ok(probe2.secret === true, 'host_set_secret reached the running backend (zero-downtime restart)');
  const secrets = await tool('host_secrets', { app: APP, env: 'production' });
  ok(/E2E_SECRET/.test(secrets.text) && !/sesame/.test(secrets.text), 'secret values are never shown back');

  await tool('host_protection', { app: APP, env: 'production', underAttack: true });
  await new Promise((r) => setTimeout(r, 2000));
  const challenged = await edge(prodHost, '/', { headers: { accept: 'text/html' } });
  ok(/Checking your browser/.test(challenged.body), 'under-attack mode serves the proof-of-work challenge');
  await tool('host_protection', { app: APP, env: 'production', underAttack: false });

  const releases = JSON.parse((await tool('host_releases', { app: APP, env: 'production' })).text);
  ok(releases.length >= 2, `release history recorded (${releases.length} releases)`);
  const rb = await tool('host_rollback', { app: APP, env: 'production' });
  ok(/Rolled back/.test(rb.text), 'instant rollback to the previous release');
  await new Promise((r) => setTimeout(r, 2000));
  ok((await edge(prodHost, '/', { headers: { accept: 'text/html' } })).status === 200, 'production still serving after rollback');

  const metrics = JSON.parse((await tool('host_metrics', { app: APP, env: 'production' })).text);
  ok(metrics.edge.requests > 0 && metrics.backend?.health === 'healthy', `metrics: ${metrics.edge.requests} requests, backend ${metrics.backend?.health}`);
  const logs = await tool('host_logs', { app: APP, env: 'production', tail: 20 });
  ok(/"msg":"request"/.test(logs.text), 'host_logs returns structured backend logs');

  // Production gate: an untested deployment cannot go straight to production.
  const dep2 = await tool('host_deploy', { app: APP, message: 'second' });
  const dep2Id = /"deploymentId": "(dep_[a-z0-9]+)"/.exec(dep2.text)[1];
  await waitDone(dep2Id);
  const gate = await mcp.callTool({ name: 'host_promote', arguments: { app: APP, deploymentId: dep2Id, to: 'production' } });
  ok(gate.isError && /pass its tests in staging/.test(gate.content[0].text), 'production refuses deployments that have not passed staging');

  if (process.env.E2E_KEEP) {
    console.log(`kept ${APP} running (E2E_KEEP); delete it with host_delete_app when done`);
  } else {
    // Deleting the app removes everything it owned.
    const del = await deleteApp(APP);
    ok(/Deleted app/.test(del), 'host_delete_app asks and the owner confirms in the dashboard');
    const leftovers = execSync(`docker ps -a --filter label=basalt.app=${APP} -q; docker network ls --format '{{.Name}}' --filter label=basalt.env | xargs -r -n1 docker network inspect --format '{{.Name}} {{len .Containers}}' 2>/dev/null | grep -c ' 0$' || true`).toString().trim();
    const pw = envFile.POSTGRES_PASSWORD;
    const dbs = execSync(`docker exec -e PGPASSWORD=${pw} basalt-postgres psql -U postgres -tAc "select count(*) from pg_database where datname like 'basalt_${APP}%'"`).toString().trim();
    ok(dbs === '0' && !/[0-9a-f]{12}/.test(leftovers), 'no containers, databases or roles left behind');
  }

  console.log(`\nALL PLATFORM E2E CHECKS PASSED (${elapsed()})`);
} catch (err) {
  failed = true;
  console.error('FAIL:', err.message);
} finally {
  if (failed) await deleteApp(APP).catch(() => {});
  await mcp.close().catch(() => {});
  rmSync(appDir, { recursive: true, force: true });
  if (failed) process.exitCode = 1;
}
