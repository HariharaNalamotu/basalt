import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_KEY } from '../../../../auth/packages/server/test/helpers.js';
import { z, type Api } from '../src/index.js';
import { createApiHarness, type ApiHarness } from './harness.js';

/**
 * Stand-in for the Basalt Data service that checks the bearer token exactly like basalt.uid()
 * does in Postgres (HS256 with the Auth project's data secret, claims), then answers.
 */
let h: ApiHarness;
let api: Api;
let dataServer: http.Server;
let secret = '';
let issuer = '';
const seen: Array<{ op: string; sub: string; body: any }> = [];

function verify(token: string) {
  const [hd, pl, sig] = token.split('.');
  if (createHmac('sha256', secret).update(`${hd}.${pl}`).digest('base64url') !== sig) return null;
  const header = JSON.parse(Buffer.from(hd!, 'base64url').toString());
  const p = JSON.parse(Buffer.from(pl!, 'base64url').toString());
  const now = Date.now() / 1000;
  if (header.alg !== 'HS256' || p.aud !== 'authenticated' || p.role !== 'authenticated' || p.iss !== issuer || p.exp <= now || p.exp - p.iat > 3600) return null;
  return p as { sub: string };
}

beforeAll(async () => {
  h = await createApiHarness();
  const signing = (await (await h.serverFetch(`/v1/platform/projects/${h.projectId}/data-protection/signing`, { headers: { authorization: `Bearer ${PLATFORM_KEY}`, 'x-basalt-owner': 'ws_test' } })).json()) as any;
  secret = signing.secret;
  issuer = signing.issuer;
  dataServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const op = req.url!.split('/').pop()!;
      const claims = verify((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (!claims) return send(401, { ok: false, error: { code: 'denied', message: 'Your login is missing, expired or not valid. Log in again.' } });
      const body = JSON.parse(raw);
      seen.push({ op, sub: claims.sub, body });
      if (body.table === 'missing') return send(404, { ok: false, error: { code: 'not_found', message: 'Not found.' } });
      if (body.input?.service === '') return send(400, { ok: false, error: { code: 'invalid_input', message: 'service is required.' } });
      if (op === 'create') return send(200, { ok: true, data: { id: 'r1', owner_id: claims.sub, ...body.input } });
      return send(200, { ok: true, data: { rows: [{ id: 'r1', owner_id: claims.sub }], next: null } });
    });
  });
  await new Promise<void>((r) => dataServer.listen(0, '127.0.0.1', r));
  api = h.makeApi({ dataUrl: `http://127.0.0.1:${(dataServer.address() as AddressInfo).port}` });
  const Booking = z.object({ id: z.string(), ownerId: z.string(), service: z.string().optional() });
  api.post('/bookings', { body: z.object({ service: z.string() }), response: Booking, status: 201 }, async ({ data, body }) => {
    const row = await data.create<{ id: string; owner_id: string; service: string }>('bookings', body);
    return { id: row.id, ownerId: row.owner_id, service: row.service };
  });
  api.get('/bookings', { response: z.array(Booking) }, async ({ data }) => (await data.list<{ id: string; owner_id: string }>('bookings')).rows.map((r) => ({ id: r.id, ownerId: r.owner_id })));
  api.get('/missing', { response: z.object({}) }, async ({ data }) => data.get('missing', '00000000-0000-0000-0000-000000000000'));
  api.get('/public-data', { auth: 'public', response: z.object({}) }, async ({ data }) => data.list('bookings') as never);
});

afterAll(async () => {
  dataServer.close();
  await h.close();
});

describe('ctx.data (Basalt Data block as the signed-in user)', () => {
  it("sends the user's Auth-issued data token, which the data layer verifies independently", async () => {
    const a = await h.signUp();
    const r = await h.call(api, 'POST', '/api/bookings', { jar: a.jar, body: { service: 'Cut' } });
    expect(r.status).toBe(201);
    expect(((await r.json()) as any).ownerId).toBe(a.userId);
    expect(seen.at(-1)).toMatchObject({ op: 'create', sub: a.userId, body: { table: 'bookings', input: { service: 'Cut' } } });
    const list = await h.call(api, 'GET', '/api/bookings', { jar: a.jar });
    expect(((await list.json()) as any)[0].ownerId).toBe(a.userId);
  });

  it('maps data errors to HTTP statuses', async () => {
    const a = await h.signUp();
    expect((await h.call(api, 'GET', '/api/missing', { jar: a.jar })).status).toBe(404);
    const bad = await h.call(api, 'POST', '/api/bookings', { jar: a.jar, body: { service: '' } });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as any).error.message).toBe('service is required.');
  });

  it('cannot be used without a signed-in user', async () => {
    const r = await h.call(api, 'GET', '/api/public-data');
    expect(r.status).toBe(401);
  });
});
