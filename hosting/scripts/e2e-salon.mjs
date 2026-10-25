// End to end for the Data block on Basalt Host: a salon booking app with no backend of its own.
// Its page signs in with Basalt Auth and saves bookings through /_basalt/data, and its rules live
// in basalt.data.json. Checks that each customer only ever reaches their own bookings on preview
// and production, and that production's rules wait for the owner's approval.
//   cd hosting/deploy && ./setup.sh basalt.localhost --local
//   BASALT_HOST_TOKEN=<workspace token> node hosting/scripts/e2e-salon.mjs
import http from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const envFile = Object.fromEntries(readFileSync(path.join(root, 'deploy/.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const ROOT = envFile.ROOT_DOMAIN;
const APP = `salon${Date.now().toString(36).slice(-5)}`;
const appDir = path.join(root, '.e2e', APP);
const ok = (c, m) => {
  if (!c) throw new Error(m);
  console.log('ok  -', m);
};
const t0 = Date.now();
const elapsed = () => `${Math.round((Date.now() - t0) / 1000)}s`;

// ---------------------------------------------------------------------------- the app
rmSync(appDir, { recursive: true, force: true });
const write = (rel, content) => {
  mkdirSync(path.dirname(path.join(appDir, rel)), { recursive: true });
  writeFileSync(path.join(appDir, rel), content);
};
write(
  'basalt.data.json',
  JSON.stringify(
    {
      tables: {
        bookings: {
          fields: {
            service: { type: 'text', maxLength: 100, required: true },
            starts_at: { type: 'timestamp', required: true },
            phone: { type: 'text', format: 'phone' },
          },
        },
      },
    },
    null,
    2,
  ),
);
write('package.json', JSON.stringify({ name: APP, private: true, type: 'module', devDependencies: { '@playwright/test': '~1.64.0' } }, null, 2));
write(
  'public/index.html',
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Salon</title></head>
<body><main>
  <h1 id="heading">Sign in</h1>
  <form id="signin"><label>Email <input id="email" type="email"></label>
  <label>Password <input id="password" type="password"></label>
  <button type="submit">Sign in</button></form>
  <section id="app" hidden>
    <form id="book"><label>Service <input id="service"></label>
    <label>Phone <input id="phone"></label><button type="submit">Book</button></form>
    <ul id="list" aria-label="bookings"></ul>
  </section>
  <p id="error" role="alert"></p>
</main><script type="module" src="/app.js"></script></body></html>`,
);
write(
  'public/app.js',
  `const $ = (id) => document.getElementById(id);
// Every read and save goes to the Data block on this site; the session cookie is the login.
async function data(op, body) {
  const r = await fetch('/_basalt/data/v1/data/' + op, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error.message);
  return j.data;
}
async function load() {
  const page = await data('list', { table: 'bookings' });
  $('signin').hidden = true; $('app').hidden = false; $('heading').textContent = 'Your bookings';
  $('list').replaceChildren(...page.rows.map((b) => Object.assign(document.createElement('li'), { textContent: b.service + ' ' + (b.phone ?? '') })));
}
$('signin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/_basalt/auth/signin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('email').value, password: $('password').value }) });
  if (!r.ok) { $('error').textContent = (await r.json()).error.message; return; }
  await load().catch((err) => ($('error').textContent = err.message));
});
$('book').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await data('create', { table: 'bookings', input: { service: $('service').value, phone: $('phone').value || undefined, starts_at: new Date(Date.now() + 864e5).toISOString() } });
    $('service').value = ''; await load();
  } catch (err) { $('error').textContent = err.message; }
});
load().catch(() => {});
`,
);
write(
  'e2e/salon.spec.ts',
  `import { test, expect } from '@playwright/test';

test('a signed-in customer can book and see their booking', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill(process.env.TEST_USER_EMAIL!);
  await page.getByLabel('Password').fill(process.env.TEST_USER_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your bookings' })).toBeVisible();
  await page.getByLabel('Service').fill('Haircut');
  await page.getByLabel('Phone').fill('555 0100');
  await page.getByRole('button', { name: 'Book' }).click();
  await expect(page.getByText('Haircut 555 0100')).toBeVisible();
});

test('signed-out data calls are refused', async ({ request }) => {
  const r = await request.post('/_basalt/data/v1/data/list', { data: { table: 'bookings' } });
  expect(r.status()).toBe(401);
});
`,
);

// ---------------------------------------------------------------------------- the agent
const mcp = new Client({ name: 'e2e-salon', version: '0' });
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
  return { text, isError: Boolean(r.isError) };
};
const must = async (name, args = {}) => {
  const r = await tool(name, args);
  if (r.isError) throw new Error(`${name}: ${r.text}`);
  return r.text;
};

// Deleting an app needs the owner: host_delete_app only asks, then the owner taps Confirm in the
// dashboard. The test plays the owner through the dashboard link the tool returns.
const deleteApp = async (app) => {
  const asked = await must('host_delete_app', { app });
  const link = /https?:\/\/\S+\/dashboard\/open\?t=\S+/.exec(asked)?.[0];
  if (!link) throw new Error(`host_delete_app gave no dashboard link: ${asked}`);
  const open = await fetch(link, { redirect: 'manual' });
  const cookie = (open.headers.get('set-cookie') ?? '').split(';')[0];
  const res = await fetch(new URL('/dashboard/api/delete-app', link), { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-basalt-dashboard': '1' }, body: JSON.stringify({ app }), signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`owner confirm failed: ${res.status} ${await res.text()}`);
};
const waitDone = async (depId) => {
  for (;;) {
    const text = await must('host_wait', { deploymentId: depId });
    const s = JSON.parse(text.slice(text.indexOf('{')));
    if (s.done) return s;
    process.stdout.write(`    … ${s.status} / ${s.pipelines.map((p) => `${p.target}:${p.stage}`).join(', ')} (${elapsed()})\n`);
  }
};
const waitPipeline = async (depId, target) => {
  for (;;) {
    const text = await must('host_deployment', { deploymentId: depId });
    const s = JSON.parse(text.slice(text.indexOf('{')));
    const p = s.pipelines.filter((x) => x.target === target).at(-1);
    if (p && p.status !== 'running') return { s, p };
    await new Promise((r) => setTimeout(r, 2000));
  }
};

/** A request through the public edge listener, as a browser on the app's own site would send it. */
function edge(host, p, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port: 8080, path: p, method, headers: { host: `${host}:8080`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } },
      (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const cookiesFrom = (res) => (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ');

/** Signs in through /_basalt/auth on the app's site and returns a data caller that uses only the cookie. */
async function customer(host, email, password, extraCookie = '') {
  const origin = `http://${host}:8080`;
  const signin = await edge(host, '/_basalt/auth/signin', { method: 'POST', headers: { origin, ...(extraCookie ? { cookie: extraCookie } : {}) }, body: { email, password } });
  if (signin.status !== 200) throw new Error(`sign in failed (${signin.status}): ${signin.text.slice(0, 300)}`);
  const cookie = [extraCookie, cookiesFrom(signin)].filter(Boolean).join('; ');
  return (op, body) => edge(host, `/_basalt/data/v1/data/${op}`, { method: 'POST', headers: { origin, cookie }, body });
}

/**
 * A real customer signing up on production: sign up, read the code from the verification email
 * (on a one-laptop demo the platform keeps it, since there's no email provider), verify, and use
 * the session that comes back. Returns a data caller like customer().
 */
async function signUp(host, env) {
  const origin = `http://${host}:8080`;
  const email = `cust-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = `Pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const r = await edge(host, '/_basalt/auth/signup', { method: 'POST', headers: { origin }, body: { email, password } });
  if (r.status !== 202 || !r.json?.signupToken) throw new Error(`sign up failed (${r.status}): ${r.text.slice(0, 300)}`);
  let code;
  for (let i = 0; i < 20 && !code; i++) {
    const mails = JSON.parse((await must('host_test_emails', { app: APP, env })).replace(/^[^[{]*/, ''));
    const list = Array.isArray(mails) ? mails : (mails.emails ?? []);
    const mail = list.find((m) => (m.to ?? m.to_addr) === email);
    code = /\b(\d{6})\b/.exec(mail?.body ?? mail?.text ?? '')?.[1];
    if (!code) await new Promise((res) => setTimeout(res, 500));
  }
  if (!code) throw new Error('no verification email arrived');
  const v = await edge(host, '/_basalt/auth/signup/verify', { method: 'POST', headers: { origin }, body: { signupToken: r.json.signupToken, code } });
  if (v.status !== 201) throw new Error(`verify failed (${v.status}): ${v.text.slice(0, 300)}`);
  const cookie = cookiesFrom(v);
  return (op, body) => edge(host, `/_basalt/data/v1/data/${op}`, { method: 'POST', headers: { origin, cookie }, body });
}

async function isolation(host, a, b, label) {
  const made = await a('create', { table: 'bookings', input: { service: 'Color', phone: '555 0111', starts_at: new Date(Date.now() + 864e5).toISOString() } });
  ok(made.status === 200 && made.json.ok, `${label}: customer A books through /_basalt/data with only a cookie`);
  const id = made.json.data.id;
  const aList = await a('list', { table: 'bookings' });
  ok(aList.json.data.rows.some((r) => r.id === id), `${label}: A sees their booking`);
  const bList = await b('list', { table: 'bookings' });
  ok(bList.status === 200 && !bList.json.data.rows.some((r) => r.id === id), `${label}: B's list doesn't include A's booking`);
  const bGet = await b('get', { table: 'bookings', id });
  ok(bGet.status === 404, `${label}: B opening A's booking gets "not found"`);
  const bEdit = await b('update', { table: 'bookings', id, input: { service: 'Hacked' } });
  ok(bEdit.status === 404, `${label}: B can't change A's booking`);
  const unsigned = await edge(host, '/_basalt/data/v1/data/list', { method: 'POST', headers: { origin: `http://${host}:8080` }, body: { table: 'bookings' } });
  ok(unsigned.status === 401, `${label}: no sign in, no data`);
}

let failed = false;
try {
  await must('host_create_app', { app: APP });
  await must('host_init', {});
  console.log(`  deploying ${APP} (build → preview → smoke + e2e)…`);
  const dep = await must('host_deploy', { app: APP, message: 'salon first version' });
  const depId = /"deploymentId": "(dep_[a-z0-9]+)"/.exec(dep)?.[1];
  const s1 = await waitDone(depId);
  if (s1.pipelines[0].status !== 'passed') console.log(JSON.stringify(s1, null, 2).slice(0, 6000));
  ok(s1.pipelines[0].status === 'passed', `preview passed in ${elapsed()}: rules from basalt.data.json applied before the app's own browser tests`);
  ok(s1.tests.some((t) => t.kind === 'e2e' && t.status === 'passed'), "the app's browser tests booked through /_basalt/data and passed");
  const guard1 = s1.tests.find((t) => t.kind === 'guard');
  ok(guard1?.status === 'passed' && guard1.summary.failed === 0 && guard1.summary.passed >= 10, `Guard ran after the tests and every attempt was refused (${guard1?.summary.passed} checks)`);

  // Preview: private, so sign in carries the share-link cookie too.
  const preview = s1.liveIn.find((e) => e.env.startsWith('p'));
  const previewHost = new URL(preview.url).hostname;
  const share = (await must('host_share_link', { app: APP, env: preview.env, ttlMinutes: 30 })).trim();
  const access = cookiesFrom(await edge(previewHost, new URL(share).pathname + new URL(share).search));
  const userA = JSON.parse(await must('host_test_user', { app: APP, env: preview.env }));
  const userB = JSON.parse(await must('host_test_user', { app: APP, env: preview.env }));
  await isolation(previewHost, await customer(previewHost, userA.email, userA.password, access), await customer(previewHost, userB.email, userB.password, access), 'preview');

  // Guard on demand, and the owner's safety receipt through the edge.
  const check = await must('host_data_check', { app: APP, env: preview.env });
  const receipt = /(http\S+\/owner\/[a-z0-9]{10}\/check\?k=\S+)/.exec(check)?.[1];
  ok(/checks passed/.test(check) && !/PROBLEM/.test(check) && Boolean(receipt), 'host_data_check: Guard on demand, nothing got through');
  const ru = new URL(receipt);
  const receiptPage = await edge(ru.hostname, ru.pathname + ru.search, { headers: { accept: 'text/html' } });
  ok(receiptPage.status === 200 && /Safety receipt/.test(receiptPage.text) && /checks passed/.test(receiptPage.text), "the owner's safety receipt opens on cloud.<root>");

  // Staging, then production. Production's first rules show data to people, so they wait for the owner.
  await must('host_promote', { app: APP, deploymentId: depId, to: 'staging' });
  const { p: stagingRun } = await waitPipeline(depId, 'staging');
  ok(stagingRun.status === 'passed', `staging passed (${elapsed()})`);
  const sStaging = JSON.parse((await must('host_deployment', { deploymentId: depId })).replace(/^[^{]*/, ''));
  ok(sStaging.tests.some((t) => t.kind === 'guard' && t.env === 'staging' && t.status === 'passed'), 'Guard passed on staging, which production requires');
  const blocked = await tool('host_promote', { app: APP, deploymentId: depId, to: 'production' });
  const approveUrl = /(http\S+\/approve\/[a-z0-9]{16}\?t=\S+)/.exec(blocked.text)?.[1];
  ok(blocked.isError && Boolean(approveUrl), 'production waits for the owner: promote returns the approval link and releases nothing');
  const prodHost = `${APP}.${ROOT}`;
  ok((await edge(prodHost, '/', { headers: { accept: 'text/html' } })).status === 404, 'nothing is live in production before approval');

  // The owner opens the link and taps "Yes".
  const u = new URL(approveUrl);
  const page = await edge(u.hostname, u.pathname + u.search, { headers: { accept: 'text/html' } });
  ok(page.status === 200 && /Who can see what/.test(page.text), "the owner's approval page explains the rules in plain words");
  const form = new URLSearchParams({ t: u.searchParams.get('t'), decision: 'approve' }).toString();
  const yes = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 8080, path: u.pathname, method: 'POST', headers: { host: `${u.hostname}:8080`, 'content-type': 'application/x-www-form-urlencoded', 'content-length': form.length } }, (res) => {
      let t = '';
      res.on('data', (d) => (t += d));
      res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    req.on('error', reject);
    req.end(form);
  });
  ok(yes.status === 200 && /rules are live/i.test(yes.text), 'the owner approved');
  const prod = await tool('host_promote', { app: APP, deploymentId: depId, to: 'production' });
  ok(!prod.isError, `live in production after approval (${elapsed()})`);

  // Production: real sign ups with email verification, no test users.
  const a = await signUp(prodHost, 'production');
  const b = await signUp(prodHost, 'production');
  ok(true, 'two customers signed up on production and verified their email');
  await isolation(prodHost, a, b, 'production');
} catch (err) {
  failed = true;
  console.log('FAIL:', err.message);
} finally {
  await deleteApp(APP).catch((err) => console.log(`WARNING: couldn't delete test app ${APP} (${err.message}). Delete it from the dashboard.`));
  await mcp.close().catch(() => {});
  rmSync(appDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
