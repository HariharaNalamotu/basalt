#!/usr/bin/env node
// Cross-user checks: replays requests as the wrong person and reports whether each one was refused.
//
//   node crossuser.mjs ..\results\without\crossuser.config.json [--round r1]
//
// A check passes ("refused") when the answer is 401/403/404/405, or a 2xx/3xx answer that contains none of the
// owner's secrets (e.g. an empty list). For writes, "verify" re-reads the record as its owner before and after
// and fails if it changed. Errors and timeouts count as "could not tell", never as a pass (security/README.md).
// See crossuser.example.json for the config format.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const cfgPath = process.argv[2];
if (!cfgPath) { console.error('usage: node crossuser.mjs <config.json> [--round r1]'); process.exit(2); }
const round = process.argv.includes('--round') ? process.argv[process.argv.indexOf('--round') + 1] : 'r1';
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
// CROSSUSER_TARGET: the same site as seen from inside Docker (set by crossuser.ps1).
const base = (process.env.CROSSUSER_TARGET || cfg.target).replace(/\/$/, '');
const fill = (s, vars) => typeof s === 'string' ? s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`) : s;
const fillDeep = (v, vars) => JSON.parse(fill(JSON.stringify(v ?? null), vars));

// ---- sign everyone in
const users = {};
async function signIn(name, u) {
  const headers = { ...(u.headers ?? {}) };
  if (u.login) {
    const res = await fetch(base + u.login.path, {
      method: u.login.method ?? 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/json', origin: base, ...(u.login.headers ?? {}) },
      body: JSON.stringify(u.login.body),
    });
    const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (cookies.length) headers.cookie = [headers.cookie, ...cookies].filter(Boolean).join('; ');
    let body = {}; try { body = await res.json(); } catch {}
    const field = u.login.tokenField; // e.g. "token" or "session.access_token"
    if (field) {
      const tok = field.split('.').reduce((o, k) => o?.[k], body);
      if (tok) headers.authorization = `Bearer ${tok}`;
    }
    if (!res.ok && res.status !== 302 && res.status !== 303) throw new Error(`${name}: sign-in answered ${res.status}`);
    if (!cookies.length && !headers.authorization) throw new Error(`${name}: sign-in gave no cookie or token (set login.tokenField?)`);
  }
  users[name] = headers;
}
for (const [name, u] of Object.entries(cfg.users)) await signIn(name, u);
users.anonymous ??= {};

async function call(as, req, vars) {
  const headers = { origin: base, ...(users[as] ?? (() => { throw new Error(`unknown user ${as}`); })()), ...(req.headers ?? {}) };
  const body = req.body === undefined ? undefined : JSON.stringify(fillDeep(req.body, vars));
  if (body) headers['content-type'] ??= 'application/json';
  const ctl = AbortSignal.timeout(15000);
  const res = await fetch(base + fill(req.path, vars), { method: req.method ?? 'GET', headers, body, redirect: 'manual', signal: ctl });
  return { status: res.status, text: await res.text() };
}

// ---- run the checks
const vars = { ...(cfg.vars ?? {}) };
const results = [];
for (const c of cfg.checks) {
  const r = { id: c.id, name: c.name, as: c.as, request: `${c.method ?? 'GET'} ${fill(c.path, vars)}` };
  try {
    let before;
    if (c.verify) before = await call(c.verify.as, c.verify, vars);
    const res = await call(c.as, c, vars);
    r.status = res.status;
    const secrets = (c.secrets ?? []).map((s) => fill(s, vars));
    const leaked = secrets.filter((s) => s && res.text.includes(s));
    let changed = false;
    if (c.verify) {
      const after = await call(c.verify.as, c.verify, vars);
      changed = after.status !== before.status || after.text !== before.text;
      r.ownerSeesChange = changed;
    }
    if (leaked.length || changed) { r.verdict = 'LEAKED'; r.why = leaked.length ? `answer contains: ${leaked.join(', ')}` : 'the owner\'s record changed'; }
    else if ([401, 403, 404, 405, 422, 400].includes(res.status)) r.verdict = 'refused';
    else if (res.status >= 200 && res.status < 400) r.verdict = secrets.length || c.verify ? 'refused' : 'could not tell';
    else { r.verdict = 'could not tell'; r.why = `status ${res.status}`; }
    if (r.verdict === 'could not tell' && !r.why) r.why = 'answered OK and the check lists no secrets to look for';
    r.sample = res.text.slice(0, 200);
  } catch (e) { r.verdict = 'could not tell'; r.why = String(e.message ?? e); }
  results.push(r);
  console.log(`${String(r.id).padStart(2)}  ${r.verdict.padEnd(14)} ${r.as.padEnd(12)} ${r.request}${r.why ? `   (${r.why})` : ''}`);
}

const refused = results.filter((r) => r.verdict === 'refused').length;
const leaked = results.filter((r) => r.verdict === 'LEAKED').length;
const unclear = results.length - refused - leaked;
const outDir = dirname(cfgPath);
writeFileSync(join(outDir, `${round}-crossuser.json`), JSON.stringify({ target: base, round, refused, leaked, unclear, results }, null, 2));
const local = new Date(Date.now() + Number(process.env.TZ_OFFSET_MIN || 0) * 60000);  // the PC's local time, like the other logs
const line = `${local.toISOString().slice(0, 19)} ${cfg.app ?? ''} ${round}-crossuser: ${refused} of ${results.length} refused, ${leaked} leaked, ${unclear} could not tell`;
appendFileSync(join(outDir, 'summary.txt'), line + '\n');
console.log('\n' + line);
