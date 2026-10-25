// Runs attack.js against fake backends (Basalt-like, leaky, Codex's false-green cases, a leak on page two) and prints each verdict: node demo/check.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
const src = fs.readFileSync(new URL('./attack.js', import.meta.url), 'utf8');
const A = { id: 'a-row', owner_id: 'A', service: 'Color', starts_at: '2026-10-27T10:00:00Z' };
const B = { id: 'b-row', owner_id: 'B', service: 'Trim', starts_at: '2026-10-28T10:00:00Z' };
const C = { id: 'c-row', owner_id: 'C', service: 'Private', starts_at: '2026-10-29T10:00:00Z' };
const ok = (data) => ({ status: 200, json: { ok: true, data } });
const no = (status, code) => ({ status, json: { ok: false, error: { code, message: code } } });
const scenarios = {
  basaltLike: (url, b, n) => {
    if (url.endsWith('/list')) return b.table === 'pg_authid' ? no(400, 'invalid_input') : ok({ rows: [B], next: null });
    if (url.endsWith('/create')) return 'owner_id' in b.input ? no(400, 'invalid_input') : ok({ ...b.input, id: 'probe', owner_id: 'B' });
    if (url.endsWith('/get')) return b.id === 'probe' ? ok({ id: 'probe', owner_id: 'B' }) : no(404, 'not_found');
    if (url.endsWith('/archive') && b.id === 'probe') return ok({});
    if (url.includes('/v1/data/') || url.endsWith('/sql')) return no(404, 'not_found');
    return no(404, 'not_found');
  },
  everythingLeaks: (url, b) => {
    if (url.endsWith('/list')) return ok({ rows: [A, B, C], next: null });
    if (url.endsWith('/create')) return ok({ ...b.input, id: 'x', owner_id: b.input.owner_id ?? 'B' });
    return ok(A);
  },
  codexFalseGreens: (url, b, n) => {
    if (url.endsWith('/list')) return b.where ? ok({ rows: [C], next: null }) : b.table === 'pg_authid' ? no(400, 'invalid_input') : ok({ rows: [B], next: null });
    if (url.endsWith('/create')) return n.create++ === 0 ? ok({ ...b.input, id: 'probe', owner_id: 'B' }) : no(503, 'unavailable');
    if (url.endsWith('/update')) return no(400, 'invalid_input');
    if (url.endsWith('/get')) return b.id === 'probe' ? ok({ id: 'probe', owner_id: 'B' }) : no(404, 'not_found');
    if (url.endsWith('/archive')) return b.id === 'probe' ? ok({}) : no(404, 'not_found');
    return no(404, 'not_found');
  },
  // An app with a unique rule (one person per class spot): a copy of B's own entry clashes.
  uniqueSpot: (url, b) => {
    const S = { id: 's-row', owner_id: 'B', class_key: 'yoga-0700', spot: 1, member_email: 'b@example.com', starts_at: '2026-10-28T10:00:00Z' };
    if (url.endsWith('/list')) return b.table === 'pg_authid' ? no(400, 'invalid_input') : b.where ? ok({ rows: [], next: null }) : ok({ rows: [S], next: null });
    if (url.endsWith('/create')) {
      if ('owner_id' in b.input) return no(400, 'invalid_input');
      if (b.input.class_key === S.class_key && b.input.spot === S.spot) return no(409, 'conflict');
      if (!/^[^@\s]+@[^@\s]+$/.test(b.input.member_email)) return no(400, 'invalid_input');
      return ok({ ...b.input, id: 'probe', owner_id: 'B' });
    }
    if (url.endsWith('/get')) return b.id === 'probe' ? ok({ id: 'probe', owner_id: 'B' }) : no(404, 'not_found');
    if (url.endsWith('/archive') && b.id === 'probe') return ok({});
    return no(404, 'not_found');
  },
  leakOnPageTwo: (url, b) => {
    if (url.endsWith('/list')) return b.table === 'pg_authid' ? no(400, 'invalid_input') : b.after ? ok({ rows: [C], next: null }) : ok({ rows: [B], next: 'p2' });
    if (url.endsWith('/create')) return 'owner_id' in b.input ? no(400, 'invalid_input') : ok({ ...b.input, id: 'probe', owner_id: 'B' });
    if (url.endsWith('/get')) return b.id === 'probe' ? ok({ id: 'probe', owner_id: 'B' }) : no(404, 'not_found');
    if (url.endsWith('/archive') && b.id === 'probe') return ok({});
    return no(404, 'not_found');
  },
};
for (const [name, fn] of Object.entries(scenarios)) {
  const n = { create: 0 };
  const writes = [];
  const ctx = {
    window: {}, console: { log() {}, table() {} }, crypto: webcrypto, btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    document: { getElementById() {}, createElement() { return { style: {}, setAttribute() {}, addEventListener() {}, querySelector() { return { focus() {} }; } }; }, body: { appendChild() {} } },
    fetch: async (url, opts) => { const b = JSON.parse(opts.body); if (/update|archive|restore|create/.test(url)) writes.push(url.split('/').pop() + ':' + (b.id ?? 'new')); const r = fn(url, b, n); return { status: r.status, json: async () => r.json }; },
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const rows = await ctx.window.basaltAttack('a-row', 'A', 'bookings');
  console.log(`== ${name}`);
  for (const r of rows) console.log(`  ${r.pass === true ? (r.badge || 'REFUSED') : r.pass === null ? "CAN'T TELL" : r.badge ? 'BROKEN' : 'LEAKED'}  ${r.title}`);
  console.log(`  writes: ${writes.join(' ')}`);
}
