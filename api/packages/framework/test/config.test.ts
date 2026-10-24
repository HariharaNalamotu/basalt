import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseServiceConfig, tightenAuth, z, type Api } from '../src/index.js';
import { createApiHarness, type ApiHarness } from './harness.js';

let h: ApiHarness;
beforeAll(async () => {
  h = await createApiHarness();
});
afterAll(async () => {
  await h.close();
});

function defineRoutes(api: Api) {
  api.get('/open', { auth: 'public', response: z.object({ ok: z.boolean() }) }, async () => ({ ok: true }));
  api.get('/mine', { response: z.object({ ok: z.boolean() }) }, async () => ({ ok: true }));
  api.post('/echo', { auth: 'public', body: z.object({ text: z.string() }), response: z.object({ text: z.string() }) }, async ({ body }) => body);
  return api;
}

describe('service config (BASALT_API_CONFIG)', () => {
  it('can tighten a public route to require sign-in, but never loosen auth', async () => {
    const api = defineRoutes(h.makeApi({ config: { routes: { 'GET /open': { auth: 'required' } } } }));
    expect((await h.call(api, 'GET', '/api/open')).status).toBe(401);
    // There is no way to express "public" in config.
    expect(() => parseServiceConfig({ routes: { 'GET /mine': { auth: 'public' } } })).toThrow(/BASALT_API_CONFIG/);
    expect(tightenAuth({ maxAgeSeconds: 300 }, { maxAgeSeconds: 900, mfa: true })).toEqual({ maxAgeSeconds: 300, mfa: true, emailVerified: undefined, strict: undefined });
    expect(tightenAuth('public', undefined)).toBe('public');
    expect(tightenAuth('optional', { mfa: true })).toMatchObject({ mfa: true });
  });

  it('adjusts rate limits, body limits and timeouts per route', async () => {
    const api = defineRoutes(h.makeApi({ config: { routes: { 'POST /echo': { rateLimit: { limit: 2, windowSeconds: 60 }, bodyLimitBytes: 50 } } } }));
    expect((await h.call(api, 'POST', '/api/echo', { body: { text: 'x'.repeat(100) } })).status).toBe(413);
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await h.call(api, 'POST', '/api/echo', { body: { text: 'hi' }, ip: '198.51.100.7' })).status);
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('disables a single route (kill switch) or the whole API (maintenance) with 503', async () => {
    const one = defineRoutes(h.makeApi({ config: { routes: { 'GET /open': { disabled: true } } } }));
    const r = await h.call(one, 'GET', '/api/open');
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('60');
    const all = defineRoutes(h.makeApi({ config: { maintenance: { enabled: true, message: 'Upgrading, back in 5 minutes.' } } }));
    const m = await h.call(all, 'GET', '/api/open');
    expect(m.status).toBe(503);
    expect(((await m.json()) as any).error.message).toBe('Upgrading, back in 5 minutes.');
    expect((await h.call(all, 'GET', '/_basalt/health', { edge: false })).status).toBe(200);
  });

  it('rejects invalid or out-of-bounds config at startup', () => {
    for (const bad of [
      '{not json',
      { limits: { defaultTimeoutMs: 600_000 } },
      { allowedOrigins: ['http://evil.example'] },
      { allowedOrigins: ['https://app.example.com/path'] },
      { routes: { 'GET todos': {} } },
      { unknownKnob: true },
      { routes: { 'GET /x': { rateLimit: { limit: 0, windowSeconds: 60 } } } },
    ]) {
      expect(() => h.makeApi({ config: bad as any }), JSON.stringify(bad)).toThrow(/BASALT_API_CONFIG/);
    }
  });

  it('reads the env var by default and reports effective policy via introspection', async () => {
    const prev = process.env.BASALT_API_CONFIG;
    process.env.BASALT_API_CONFIG = JSON.stringify({ routes: { 'GET /mine': { auth: { mfa: true } } }, defaultRateLimits: { public: { limit: 5, windowSeconds: 10 } } });
    try {
      const api = defineRoutes(h.makeApi());
      const intro = (await (await h.call(api, 'GET', '/_basalt/introspect')).json()) as any;
      const mine = intro.routes.find((r: any) => r.key === 'GET /mine');
      expect(mine.auth).toMatchObject({ mfa: true });
      expect(intro.routes.find((r: any) => r.key === 'GET /open').rateLimit).toEqual({ limit: 5, windowSeconds: 10 });
      expect((await h.call(api, 'GET', '/_basalt/introspect', { edge: false })).status).toBe(403);
    } finally {
      if (prev === undefined) delete process.env.BASALT_API_CONFIG;
      else process.env.BASALT_API_CONFIG = prev;
    }
  });
});
