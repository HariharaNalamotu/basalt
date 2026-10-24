import { describe, expect, it } from 'vitest';
import { createApiClient, ApiRequestError } from '../src/client.js';
import { createSafeFetch, isBlockedAddress, SafeFetchError } from '../src/safe-fetch.js';
import { fromDatabaseError } from '../src/errors.js';
import { signEdgeRequest, verifyEdgeSignature } from '../src/edge.js';

describe('SSRF-safe fetch', () => {
  it('classifies internal addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '64:ff9b::a9fe:a9fe', '224.0.0.1', '255.255.255.255']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '151.101.1.69']) expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it('refuses internal destinations, odd schemes and ports', async () => {
    const f = createSafeFetch();
    const cases: Array<[string, string]> = [
      ['http://127.0.0.1/', 'blocked_destination'],
      ['http://169.254.169.254/latest/meta-data/', 'blocked_destination'],
      ['http://[::1]/', 'blocked_destination'],
      ['http://localhost/', 'blocked_destination'],
      ['file:///etc/passwd', 'bad_url'],
      ['http://user:pw@example.com/', 'bad_url'],
      ['https://example.com:22/', 'blocked_destination'],
      ['not a url', 'bad_url'],
    ];
    for (const [url, reason] of cases) {
      const err = await f(url).catch((e) => e);
      expect(err, url).toBeInstanceOf(SafeFetchError);
      expect(err.reason, url).toBe(reason);
    }
  });

  it('checks the resolved address, so public-looking names pointing inside are blocked (DNS rebinding)', async () => {
    const f = createSafeFetch({}, { lookup: (_h, _o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]) });
    const err = await f('http://rebind.example/').catch((e) => e);
    expect(err).toBeInstanceOf(SafeFetchError);
    expect(err.reason).toBe('blocked_destination');
  });
});

describe('edge signatures', () => {
  it('bind method, path and request id, and expire', () => {
    const s = 'x'.repeat(40);
    const sig = signEdgeRequest(s, { method: 'POST', pathAndQuery: '/api/a?b=1', requestId: 'req-12345678' });
    expect(verifyEdgeSignature(s, sig, { method: 'POST', pathAndQuery: '/api/a?b=1', requestId: 'req-12345678' })).toBe(true);
    expect(verifyEdgeSignature(s, sig, { method: 'GET', pathAndQuery: '/api/a?b=1', requestId: 'req-12345678' })).toBe(false);
    expect(verifyEdgeSignature(s, sig, { method: 'POST', pathAndQuery: '/api/a?b=2', requestId: 'req-12345678' })).toBe(false);
    expect(verifyEdgeSignature(s, sig, { method: 'POST', pathAndQuery: '/api/a?b=1', requestId: 'req-other-1' })).toBe(false);
    expect(verifyEdgeSignature('y'.repeat(40), sig, { method: 'POST', pathAndQuery: '/api/a?b=1', requestId: 'req-12345678' })).toBe(false);
    expect(verifyEdgeSignature(s, sig, { method: 'POST', pathAndQuery: '/api/a?b=1', requestId: 'req-12345678' }, Date.now() + 120_000)).toBe(false);
  });
});

describe('database error mapping', () => {
  it.each([
    ['23505', 409], ['23503', 409], ['23502', 422], ['22P02', 400], ['42501', 403], ['28000', 401], ['40001', 503], ['57014', 504],
  ])('%s -> %i', (code, status) => {
    expect(fromDatabaseError({ code })?.status).toBe(status);
  });
  it('leaves unknown errors as 500s', () => {
    expect(fromDatabaseError(new Error('x'))).toBeNull();
    expect(fromDatabaseError({ code: '42P01' })).toBeNull();
  });
});

describe('API client', () => {
  it('throws typed errors and returns undefined for 204', async () => {
    const client = createApiClient({
      fetch: async (url) =>
        String(url).endsWith('/gone')
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify({ error: { code: 'validation_failed', message: 'Some fields are invalid.', requestId: 'r1', details: [{ path: 'body.title', message: 'Required' }] } }), { status: 422 }),
    });
    expect(await client.delete('/gone')).toBeUndefined();
    const err: any = await client.post("/todos", {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 422, code: 'validation_failed', requestId: 'r1' });
    expect(err.details[0].path).toBe('body.title');
  });

  it('retries writes after 503 with the same Idempotency-Key', async () => {
    const keys: string[] = [];
    let calls = 0;
    const client = createApiClient({
      fetch: async (_url, init) => {
        keys.push(new Headers(init?.headers).get('idempotency-key')!);
        return ++calls === 1 ? new Response('{}', { status: 503, headers: { 'retry-after': '0' } }) : new Response('{"id":1}', { status: 201 });
      },
    });
    expect(await client.post('/charges', { amount: 1 })).toEqual({ id: 1 });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects protocol-relative paths', async () => {
    await expect(createApiClient({ fetch: fetch }).get('//evil.example/x')).rejects.toThrow(/single/);
  });
});
