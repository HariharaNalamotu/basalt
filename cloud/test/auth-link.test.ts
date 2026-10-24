// AuthLink's test logins, with Basalt Auth faked by a stubbed fetch. No database needed.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { AuthLink } from '../src/auth.ts';

const masterKey = 'k'.repeat(64);
const token = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

test('a test person made before the password change still signs in', async () => {
  // Accounts made by earlier versions got a password derived from the plain name.
  const legacy = `Tp-${createHmac('sha256', masterKey).update('test-user|prj_1|alice').digest('base64url')}`;
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (String(url).endsWith('/users')) return Response.json({ error: { message: 'Exists' } }, { status: 409 });
    if (JSON.parse(String(init.body)).password !== legacy) return Response.json({ error: { message: 'Invalid credentials' } }, { status: 401 });
    return Response.json({ accessToken: token({ bdg: 'grant.for.alice', exp: Math.floor(Date.now() / 1000) + 3600 }), user: { id: 'u1' } });
  }) as typeof fetch;
  try {
    const login = await new AuthLink({ url: 'http://auth.test', platformKey: 'p', masterKey }).testLogin('prj_1', 'alice');
    assert.equal(login.token, 'grant.for.alice');
  } finally {
    globalThis.fetch = real;
  }
});
