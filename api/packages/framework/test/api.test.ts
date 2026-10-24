import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, errors, sql, z, type Api } from '../src/index.js';
import { APP, createApiHarness, EDGE_SECRET, type ApiHarness } from './harness.js';

let h: ApiHarness;
let api: Api;

const Todo = z.object({ id: z.coerce.number(), title: z.string(), ownerId: z.uuid() });
const toTodo = (r: any) => ({ id: r.id, title: r.title, ownerId: r.owner_id, internalNote: r.internal_note });

beforeAll(async () => {
  h = await createApiHarness();
  api = h.makeApi();

  api.get('/me', { response: z.object({ id: z.uuid(), email: z.string() }) }, async ({ user }) => ({ id: user.id, email: user.email }));

  api.get('/todos', { query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }), response: z.array(Todo) }, async ({ sql: q, query }) =>
    (await q`SELECT * FROM todos ORDER BY id LIMIT ${query.limit}`).map(toTodo),
  );

  api.post('/todos', { body: z.object({ title: z.string().min(1).max(200) }), response: Todo, status: 201 }, async ({ sql: q, body }) =>
    toTodo(await q.one`INSERT INTO todos (title) VALUES (${body.title}) RETURNING *`),
  );

  api.get('/todos/:id', { params: z.object({ id: z.coerce.number().int().positive() }), response: Todo }, async ({ sql: q, params }) =>
    toTodo(await q.one`SELECT * FROM todos WHERE id = ${params.id}`),
  );

  api.delete('/todos/:id', { params: z.object({ id: z.coerce.number().int().positive() }), response: null }, async ({ sql: q, params }) => {
    const r = await q.exec`DELETE FROM todos WHERE id = ${params.id}`;
    if (r.rowCount === 0) throw errors.notFound('Todo not found.');
  });

  api.post('/todos/plant', { body: z.object({ ownerId: z.uuid() }), response: null }, async ({ sql: q, body }) => {
    await q`INSERT INTO todos (owner_id, title) VALUES (${body.ownerId}, 'planted')`;
  });

  api.post('/todos/fail-after-insert', { body: z.object({ title: z.string() }), response: null }, async ({ sql: q, body }) => {
    await q`INSERT INTO todos (title) VALUES (${body.title})`;
    throw new Error('boom: internal detail /etc/secrets');
  });

  api.get('/search', { query: z.object({ q: z.string().max(100) }), response: z.array(Todo) }, async ({ sql: q, query }) =>
    (await q`SELECT * FROM todos WHERE title = ${query.q}`).map(toTodo),
  );

  api.get('/announcements', { auth: 'public', response: z.array(z.object({ body: z.string() })), cache: { maxAgeSeconds: 60 } }, async ({ sql: q }) =>
    q<{ body: string }>`SELECT body FROM announcements`,
  );

  api.get('/public/todos-count', { auth: 'public', response: z.object({ n: z.number() }) }, async ({ sql: q }) => ({
    n: Number((await q.one<{ n: string }>`SELECT count(*) AS n FROM todos`).n),
  }));

  api.get('/whoami', { auth: 'optional', response: z.object({ id: z.uuid().nullable() }) }, async ({ user }) => ({ id: user?.id ?? null }));

  api.post('/contact', { auth: 'public', body: z.object({ message: z.string().max(1000) }), response: z.object({ ok: z.boolean() }), status: 202, rateLimit: { limit: 3, windowSeconds: 60 } }, async () => ({ ok: true }));

  api.get('/leaky', { response: z.object({ id: z.uuid() }) }, async ({ user }) => ({ id: user.id, passwordHash: '$argon2id$...', email: user.email }) as any);
  api.get('/broken-response', { response: z.object({ count: z.number() }) }, async () => ({ count: 'many' }) as any);
  api.get('/slow', { timeoutMs: 200, response: z.object({ ok: z.boolean() }) }, async ({ signal }) => {
    await new Promise((r) => setTimeout(r, 1000));
    return { ok: !signal.aborted };
  });
  api.get('/headers', { response: z.object({ cookie: z.string().nullable(), ua: z.string().nullable() }) }, async ({ request }) => ({
    cookie: request.header('cookie') ?? null,
    ua: request.header('user-agent') ?? null,
  }));
  api.post('/charges', { body: z.object({ amount: z.number().int().positive() }), response: z.object({ id: z.string() }), status: 201, idempotency: 'required', auth: { maxAgeSeconds: 600 } }, async ({ sql: q, body }) => {
    const row = await q.one<{ id: string }>`INSERT INTO todos (title) VALUES (${'charge ' + body.amount + ' ' + Math.random()}) RETURNING id`;
    return { id: String(row.id) };
  });
  api.post('/created', { body: null, response: z.object({ id: z.number() }) }, async ({ reply }) => reply(201, { id: 7 }, { location: '/api/created/7' }));
  api.get('/mfa-only', { auth: { mfa: true }, response: z.object({ ok: z.boolean() }) }, async () => ({ ok: true }));
});

afterAll(async () => {
  await h.close();
});

const json = async (r: Response) => (await r.json()) as any;

describe('edge enforcement (origin not reachable directly)', () => {
  it('rejects requests that did not come through the platform edge', async () => {
    const { jar } = await h.signUp();
    for (const edge of [false, 'tamper', 'stale'] as const) {
      const r = await h.call(api, 'GET', '/api/me', { jar, edge });
      expect(r.status, String(edge)).toBe(403);
      expect((await json(r)).error.code).toBe('direct_access_forbidden');
    }
    expect((await h.call(api, 'GET', '/api/me', { jar })).status).toBe(200);
  });

  it('keeps a minimal unsigned health endpoint for load balancers', async () => {
    const r = await h.call(api, 'GET', '/_basalt/health', { edge: false });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('propagates the edge request id', async () => {
    const r = await h.call(api, 'GET', '/api/announcements');
    expect(r.headers.get('x-request-id')).toMatch(/^req-/);
  });
});

describe('auth is enforced by default', () => {
  it('requires a signed-in user unless the route says otherwise', async () => {
    const r = await h.call(api, 'GET', '/api/me');
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(/Bearer/);
    expect((await json(r)).error.code).toBe('unauthenticated');
    const { jar, userId } = await h.signUp();
    expect((await json(await h.call(api, 'GET', '/api/me', { jar }))).id).toBe(userId);
  });

  it('accepts bearer tokens from native clients', async () => {
    const { accessToken, userId } = await h.signUp();
    const r = await h.call(api, 'GET', '/api/me', { headers: { authorization: `Bearer ${accessToken}` } });
    expect((await json(r)).id).toBe(userId);
  });

  it('public and optional routes behave as declared', async () => {
    expect((await h.call(api, 'GET', '/api/announcements')).status).toBe(200);
    expect(await json(await h.call(api, 'GET', '/api/whoami'))).toEqual({ id: null });
    const { jar, userId } = await h.signUp();
    expect(await json(await h.call(api, 'GET', '/api/whoami', { jar }))).toEqual({ id: userId });
  });

  it('enforces MFA and step-up requirements with 403', async () => {
    const { jar } = await h.signUp();
    const r = await h.call(api, 'GET', '/api/mfa-only', { jar });
    expect(r.status).toBe(403);
    expect((await json(r)).error.code).toBe('mfa_required');
  });

  it('never exposes cookies or authorization headers to handlers', async () => {
    const { jar } = await h.signUp();
    const r = await json(await h.call(api, 'GET', '/api/headers', { jar, headers: { 'user-agent': 'test-agent' } }));
    expect(r).toEqual({ cookie: null, ua: 'test-agent' });
  });
});

describe('database-enforced ownership through ctx.sql', () => {
  it('each user only ever sees their own rows, even without WHERE clauses', async () => {
    const a = await h.signUp();
    const b = await h.signUp();
    const created = await h.call(api, 'POST', '/api/todos', { jar: a.jar, body: { title: 'a-private' } });
    expect(created.status).toBe(201);
    const todo = await json(created);
    expect(todo.ownerId).toBe(a.userId);
    await h.call(api, 'POST', '/api/todos', { jar: b.jar, body: { title: 'b-private' } });
    const listA = await json(await h.call(api, 'GET', '/api/todos', { jar: a.jar }));
    expect(listA.every((t: any) => t.ownerId === a.userId)).toBe(true);
    expect(listA.map((t: any) => t.title)).toContain('a-private');
    // B asking for A's todo by id gets 404 (not 403: existence isn't revealed).
    expect((await h.call(api, 'GET', `/api/todos/${todo.id}`, { jar: b.jar })).status).toBe(404);
    expect((await h.call(api, 'DELETE', `/api/todos/${todo.id}`, { jar: b.jar })).status).toBe(404);
    expect((await h.call(api, 'GET', `/api/todos/${todo.id}`, { jar: a.jar })).status).toBe(200);
    expect((await h.call(api, 'DELETE', `/api/todos/${todo.id}`, { jar: a.jar })).status).toBe(204);
  });

  it('rejects writing rows owned by someone else (403) and maps constraint errors (409)', async () => {
    const a = await h.signUp();
    const b = await h.signUp();
    const r = await h.call(api, 'POST', '/api/todos/plant', { jar: b.jar, body: { ownerId: a.userId } });
    expect(r.status).toBe(403);
    await h.call(api, 'POST', '/api/todos', { jar: a.jar, body: { title: 'dupe' } });
    const dupe = await h.call(api, 'POST', '/api/todos', { jar: a.jar, body: { title: 'dupe' } });
    expect(dupe.status).toBe(409);
    expect((await json(dupe)).error.code).toBe('conflict');
  });

  it('public routes run without a grant, so protected tables are invisible', async () => {
    const a = await h.signUp();
    await h.call(api, 'POST', '/api/todos', { jar: a.jar, body: { title: 'hidden from public' } });
    expect(await json(await h.call(api, 'GET', '/api/public/todos-count'))).toEqual({ n: 0 });
  });

  it('rolls back the transaction when the handler fails, without leaking internals', async () => {
    const a = await h.signUp();
    const r = await h.call(api, 'POST', '/api/todos/fail-after-insert', { jar: a.jar, body: { title: 'ghost' } });
    expect(r.status).toBe(500);
    const body = await json(r);
    expect(body.error.code).toBe('internal_error');
    expect(JSON.stringify(body)).not.toContain('/etc/secrets');
    expect(body.error.requestId).toBeTruthy();
    const list = await json(await h.call(api, 'GET', '/api/todos', { jar: a.jar }));
    expect(list.map((t: any) => t.title)).not.toContain('ghost');
  });

  it('treats injection payloads as plain values', async () => {
    const a = await h.signUp();
    await h.call(api, 'POST', '/api/todos', { jar: a.jar, body: { title: 'normal' } });
    const evil = encodeURIComponent("x' OR '1'='1");
    const r = await h.call(api, 'GET', `/api/search?q=${evil}`, { jar: a.jar });
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual([]);
  });
});

describe('HTTP semantics', () => {
  it('returns the right status codes', async () => {
    const { jar } = await h.signUp();
    const cases: Array<[string, string, Parameters<ApiHarness['call']>[3], number, string?]> = [
      ['GET', '/api/nope', { jar }, 404, 'not_found'],
      ['GET', '/api/todos/abc', { jar }, 400, 'invalid_request'],
      ['GET', '/api/todos?limit=1000', { jar }, 400, 'invalid_request'],
      ['POST', '/api/todos', { jar, rawBody: '{"title":', headers: { 'content-type': 'application/json' } }, 400, 'malformed_json'],
      ['POST', '/api/todos', { jar, rawBody: 'title=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, 415, 'unsupported_media_type'],
      ['POST', '/api/todos', { jar, body: { title: '' } }, 422, 'validation_failed'],
      ['POST', '/api/todos', { jar, body: { title: 'x'.repeat(200_000) } }, 413, 'payload_too_large'],
      ['GET', '/api/created', { jar }, 405, 'method_not_allowed'],
    ];
    for (const [method, path, opts, status, code] of cases) {
      const r = await h.call(api, method, path, opts);
      expect(r.status, `${method} ${path}`).toBe(status);
      if (code) expect((await json(r)).error.code, `${method} ${path}`).toBe(code);
    }
    const r405 = await h.call(api, 'PUT', '/api/todos', { jar, body: {} });
    expect(r405.status).toBe(405);
    expect(r405.headers.get('allow')).toContain('GET');
    expect(r405.headers.get('allow')).toContain('POST');
  });

  it('reports field-level validation details', async () => {
    const { jar } = await h.signUp();
    const r = await json(await h.call(api, 'POST', '/api/todos', { jar, body: { title: 42 } }));
    expect(r.error.details[0].path).toBe('body.title');
  });

  it('201 with Location, 202, 204 and HEAD', async () => {
    const { jar } = await h.signUp();
    const created = await h.call(api, 'POST', '/api/created', { jar });
    expect(created.status).toBe(201);
    expect(created.headers.get('location')).toBe('/api/created/7');
    expect((await h.call(api, 'POST', '/api/contact', { body: { message: 'hi' } })).status).toBe(202);
    const head = await h.call(api, 'HEAD', '/api/announcements');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('strips fields the response schema does not declare (no accidental data exposure)', async () => {
    const { jar } = await h.signUp();
    const body = await json(await h.call(api, 'GET', '/api/leaky', { jar }));
    expect(Object.keys(body)).toEqual(['id']);
    const todos = await h.call(api, 'POST', '/api/todos', { jar, body: { title: 'with note' } });
    expect(JSON.stringify(await json(todos))).not.toContain('secret');
  });

  it('turns an invalid response into a generic 500 instead of sending it', async () => {
    const { jar } = await h.signUp();
    const r = await h.call(api, 'GET', '/api/broken-response', { jar });
    expect(r.status).toBe(500);
    expect(JSON.stringify(await json(r))).not.toContain('many');
  });

  it('times out slow handlers with 504', async () => {
    const { jar } = await h.signUp();
    const r = await h.call(api, 'GET', '/api/slow', { jar });
    expect(r.status).toBe(504);
  });

  it('sets security and caching headers', async () => {
    const { jar } = await h.signUp();
    const personal = await h.call(api, 'GET', '/api/me', { jar });
    expect(personal.headers.get('cache-control')).toBe('no-store');
    expect(personal.headers.get('x-content-type-options')).toBe('nosniff');
    expect(personal.headers.get('vary')).toMatch(/Cookie/);
    const pub = await h.call(api, 'GET', '/api/announcements');
    expect(pub.headers.get('cache-control')).toBe('public, max-age=60');
  });
});

describe('abuse protection', () => {
  it('rate limits with 429 and Retry-After', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await h.call(api, 'POST', '/api/contact', { body: { message: 'spam' }, ip: '198.51.100.99' })).status);
    expect(statuses).toEqual([202, 202, 202, 429, 429]);
    const r = await h.call(api, 'POST', '/api/contact', { body: { message: 'spam' }, ip: '198.51.100.99' });
    expect(r.headers.get('retry-after')).toBeTruthy();
    // A different client is unaffected.
    expect((await h.call(api, 'POST', '/api/contact', { body: { message: 'hi' }, ip: '198.51.100.100' })).status).toBe(202);
  });

  it('blocks cross-site writes and answers CORS preflight only for allowed origins', async () => {
    const { jar } = await h.signUp();
    const forged = await h.call(api, 'POST', '/api/todos', { jar, body: { title: 'csrf' }, origin: 'https://evil.example' });
    expect(forged.status).toBe(403);
    expect((await json(forged)).error.code).toBe('origin_not_allowed');
    const publicForged = await h.call(api, 'POST', '/api/contact', { body: { message: 'x' }, origin: 'https://evil.example' });
    expect(publicForged.status).toBe(403);

    const cross = h.makeApi({ allowedOrigins: ['https://admin.example.com'] });
    cross.get('/ping', { auth: 'public', response: z.object({ ok: z.boolean() }) }, async () => ({ ok: true }));
    const pre = await h.call(cross, 'OPTIONS', '/api/ping', { origin: 'https://admin.example.com', headers: { 'access-control-request-method': 'GET' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://admin.example.com');
    const bad = await h.call(cross, 'OPTIONS', '/api/ping', { origin: 'https://evil.example', headers: { 'access-control-request-method': 'GET' } });
    expect(bad.status).toBe(403);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('sheds load with 503 when too many requests are in flight', async () => {
    const small = h.makeApi({ limits: { maxInFlight: 1 } });
    small.get('/wait', { auth: 'public', response: z.object({ ok: z.boolean() }) }, async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { ok: true };
    });
    const [a, b] = await Promise.all([h.call(small, 'GET', '/api/wait'), h.call(small, 'GET', '/api/wait')]);
    expect([a.status, b.status].sort()).toEqual([200, 503]);
    expect([a, b].find((r) => r.status === 503)!.headers.get('retry-after')).toBe('1');
  });
});

describe('idempotency keys', () => {
  it('replays the original response instead of repeating the write', async () => {
    const { jar } = await h.signUp();
    const key = `key-${Date.now()}-abc`;
    const first = await h.call(api, 'POST', '/api/charges', { jar, body: { amount: 500 }, headers: { 'idempotency-key': key } });
    expect(first.status).toBe(201);
    const second = await h.call(api, 'POST', '/api/charges', { jar, body: { amount: 500 }, headers: { 'idempotency-key': key } });
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(await json(second)).toEqual(await json(first));
    const misuse = await h.call(api, 'POST', '/api/charges', { jar, body: { amount: 999 }, headers: { 'idempotency-key': key } });
    expect(misuse.status).toBe(422);
    expect((await json(misuse)).error.code).toBe('idempotency_key_reused');
    const missing = await h.call(api, 'POST', '/api/charges', { jar, body: { amount: 1 } });
    expect(missing.status).toBe(400);
  });

  it('scopes keys per user', async () => {
    const a = await h.signUp();
    const b = await h.signUp();
    const key = `shared-key-${Date.now()}`;
    const ra = await json(await h.call(api, 'POST', '/api/charges', { jar: a.jar, body: { amount: 1 }, headers: { 'idempotency-key': key } }));
    const rb = await json(await h.call(api, 'POST', '/api/charges', { jar: b.jar, body: { amount: 1 }, headers: { 'idempotency-key': key } }));
    expect(ra.id).not.toBe(rb.id);
  });
});

describe('route registration rejects unsafe definitions at startup', () => {
  const fresh = () => h.makeApi();
  const R = z.object({ ok: z.boolean() });
  const noop = async () => ({ ok: true });
  it.each([
    ['path params without a schema', (a: Api) => a.get('/x/:id', { response: R }, noop as any), /no params schema/],
    ['param missing from schema', (a: Api) => a.get('/x/:id', { params: z.object({ other: z.string() }), response: R }, noop as any), /missing "id"/],
    ['no response schema', (a: Api) => a.get('/x', {} as any, noop as any), /response schema is required/],
    ['POST without body schema', (a: Api) => a.post('/x', { response: R }, noop as any), /body schema is required/],
    ['cache on authenticated route', (a: Api) => a.get('/x', { response: R, cache: { maxAgeSeconds: 60 } }, noop as any), /only allowed on public GET/],
    ['wildcard path', (a: Api) => a.get('/x/*', { response: R }, noop as any), /path must be like/],
    ['reserved prefix', (a: Api) => a.get('/_basalt/x', { response: R }, noop as any), /path must be like|reserved/],
    ['out-of-bounds timeout', (a: Api) => a.get('/x', { response: R, timeoutMs: 600_000 }, noop as any), /timeoutMs/],
  ])('%s', (_name, define, message) => {
    expect(() => define(fresh())).toThrow(message);
  });

  it('rejects duplicates and late registration', async () => {
    const a = fresh();
    a.get('/dup', { auth: 'public', response: R }, noop);
    expect(() => a.get('/dup', { auth: 'public', response: R }, noop)).toThrow(/duplicate/);
    await h.call(a, 'GET', '/api/dup');
    expect(() => a.get('/late', { auth: 'public', response: R }, noop)).toThrow(/before the API starts/);
  });

  it('refuses to start in production without the edge secret or shared state', () => {
    expect(() => createApi({ env: 'production', auth: h.makeApi as any, database: false })).toThrow(/BASALT_EDGE_SECRET/);
    expect(() => createApi({ env: 'production', edgeSecret: EDGE_SECRET, database: false })).toThrow(/REDIS_URL/);
  });
});

describe('sql tag', () => {
  it('parameterizes values and composes fragments', () => {
    const order = sql`DESC`;
    const where = sql.join([sql`done = ${true}`, sql`title = ${"'; DROP TABLE todos; --"}`], sql` AND `);
    const q = sql`SELECT * FROM todos WHERE ${where} ORDER BY id ${order} LIMIT ${10}`.toQuery();
    expect(q.text).toBe('SELECT * FROM todos WHERE done = $1 AND title = $2 ORDER BY id DESC LIMIT $3');
    expect(q.values).toEqual([true, "'; DROP TABLE todos; --", 10]);
  });
});

describe('OpenAPI', () => {
  it('documents routes, auth and errors from the definitions', () => {
    const doc = api.openapi({ title: 'Todos' }) as any;
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths['/api/todos/{id}'].get.parameters[0]).toMatchObject({ name: 'id', in: 'path', required: true });
    expect(doc.paths['/api/todos'].post.responses['201']).toBeTruthy();
    expect(doc.paths['/api/todos'].post.responses['422']).toBeTruthy();
    expect(doc.paths['/api/announcements'].get.security).toEqual([]);
    expect(doc.paths['/api/me'].get.security.length).toBeGreaterThan(0);
  });

  it('is not served to unsigned callers in production-like setups', async () => {
    expect((await h.call(api, 'GET', '/_basalt/openapi.json', { edge: false })).status).toBe(403);
  });
});

export { APP };
