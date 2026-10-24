import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, GOOD_PASSWORD, ORIGIN, PLATFORM_KEY, type Harness } from '../../server/test/helpers.js';
import { HttpControlPlane, type ControlPlane } from '../src/control-plane.js';
import { FRAMEWORKS, integrationGuide } from '../src/guides.js';
import { reviewCode } from '../src/review.js';
import { registerAuthTools } from '../src/tools.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const inProcessFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  return h.app.request(url.pathname + url.search, init as RequestInit);
};

async function connect(cp: ControlPlane) {
  const server = new McpServer({ name: 'basalt-auth-test', version: '0.0.0' });
  registerAuthTools(server, cp);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'agent', version: '0.0.0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), isError: r.isError === true };
  };
  return { client, call };
}

const controlPlane = (owner = 'ws_agent') => new HttpControlPlane('https://auth.test', PLATFORM_KEY, owner, inProcessFetch);

describe('MCP tools', () => {
  it('exposes the documented tool set with safety annotations', async () => {
    const { client } = await connect(controlPlane());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'auth_create_project', 'auth_delete_user', 'auth_enable_data_protection', 'auth_get_project', 'auth_get_user', 'auth_integration_guide',
        'auth_list_events', 'auth_list_projects', 'auth_list_users', 'auth_review_code', 'auth_revoke_user_sessions',
        'auth_rotate_secret_key', 'auth_rotate_signing_key', 'auth_security_rules', 'auth_update_project', 'auth_update_user',
      ].sort(),
    );
    const del = tools.find((t) => t.name === 'auth_delete_user')!;
    expect(del.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'auth_integration_guide')!.annotations?.readOnlyHint).toBe(true);
  });

  it('creates a project and returns ready-to-use env vars', async () => {
    const { call } = await connect(controlPlane());
    const r = await call('auth_create_project', { name: 'Todo App', allowedOrigins: [ORIGIN, 'http://localhost:5173'] });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/BASALT_PROJECT_ID=prj_/);
    expect(r.text).toMatch(/BASALT_AUTH_URL=https:\/\/auth\.test/);
    expect(r.text).toMatch(/BASALT_AUTH_SECRET_KEY=bslt_sk_/);
    const projectId = /BASALT_PROJECT_ID=(prj_\w+)/.exec(r.text)![1]!;

    // The new project actually works end-to-end.
    const signup = await h.request('POST', `/v1/projects/${projectId}/signup`, { origin: ORIGIN, body: { email: 'mcp@example.com', password: GOOD_PASSWORD } });
    expect(signup.status).toBe(202);
  });

  it('never shows the secret to the agent when the platform stores it', async () => {
    const stored: Record<string, string> = {};
    const cp = controlPlane();
    const platformCp: ControlPlane = Object.assign(Object.create(Object.getPrototypeOf(cp)), cp, {
      storeProjectSecret: async (id: string, key: string) => {
        stored[id] = key;
        return { envVar: 'BASALT_AUTH_SECRET_KEY' };
      },
    });
    const { call } = await connect(platformCp);
    const r = await call('auth_create_project', { name: 'Hidden Secret App' });
    expect(r.text).not.toMatch(/bslt_sk_/);
    expect(Object.values(stored)[0]).toMatch(/^bslt_sk_/);
    const projectId = /BASALT_PROJECT_ID=(prj_\w+)/.exec(r.text)![1]!;
    const rot = await call('auth_rotate_secret_key', { projectId });
    expect(rot.text).not.toMatch(/bslt_sk_/);
  });

  it('reports validation errors from the service as tool errors', async () => {
    const { call } = await connect(controlPlane());
    const r = await call('auth_create_project', { name: 'x', allowedOrigins: ['http://evil.com'] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/https/);
    const s = await call('auth_create_project', { name: 'x', settings: { accessTokenTtlSeconds: 999999 } });
    expect(s.isError).toBe(true);
  });

  it('cannot reach projects owned by another workspace', async () => {
    const mine = await connect(controlPlane('ws_alice'));
    const created = await mine.call('auth_create_project', { name: 'Alice App' });
    const projectId = /BASALT_PROJECT_ID=(prj_\w+)/.exec(created.text)![1]!;
    const theirs = await connect(controlPlane('ws_mallory'));
    for (const [tool, args] of [
      ['auth_get_project', { projectId }],
      ['auth_list_users', { projectId }],
      ['auth_rotate_secret_key', { projectId }],
      ['auth_update_project', { projectId, allowedOrigins: ['https://mallory.example'] }],
    ] as const) {
      const r = await theirs.call(tool, args);
      expect(r.isError, tool).toBe(true);
      expect(r.text, tool).toMatch(/not_found/);
    }
    expect((await theirs.call('auth_list_projects')).text).not.toContain(projectId);
  });

  it('manages users, requiring explicit confirmation to delete', async () => {
    const { call } = await connect(controlPlane());
    const created = await call('auth_create_project', { name: 'Users App', settings: { requireEmailVerification: false } });
    const projectId = /BASALT_PROJECT_ID=(prj_\w+)/.exec(created.text)![1]!;
    const signup = await h.request('POST', `/v1/projects/${projectId}/signup`, { body: { email: 'del@example.com', password: GOOD_PASSWORD } });
    const userId = ((await signup.json()) as any).user.id;

    const found = await call('auth_list_users', { projectId, email: 'del@example.com' });
    expect(found.text).toContain(userId);
    const upd = await call('auth_update_user', { projectId, userId, metadata: { role: 'admin' } });
    expect(upd.text).toContain('"role": "admin"');
    const noConfirm = await call('auth_delete_user', { projectId, userId });
    expect(noConfirm.isError).toBe(true);
    const del = await call('auth_delete_user', { projectId, userId, confirm: true });
    expect(del.isError).toBe(false);
    const events = await call('auth_list_events', { projectId });
    expect(events.text).toContain('user.deleted');
  });

  it('serves guides and rules', async () => {
    const { call } = await connect(controlPlane());
    for (const framework of FRAMEWORKS) {
      const g = await call('auth_integration_guide', { framework });
      expect(g.text).toContain('Non-negotiable rules');
    }
    expect((await call('auth_security_rules')).text).toMatch(/Never build auth yourself/);
  });
});

describe('data protection tools', () => {
  it('returns install SQL with handling instructions when the platform cannot run it', async () => {
    const { call } = await connect(controlPlane());
    const created = await call('auth_create_project', { name: 'DP App' });
    const projectId = /BASALT_PROJECT_ID=(prj_\w+)/.exec(created.text)![1]!;
    const r = await call('auth_enable_data_protection', { projectId });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('CREATE OR REPLACE FUNCTION basalt_auth.uid()');
    expect(r.text).toMatch(/Do NOT commit/);
  });

  it('never shows the SQL or key when the platform installs it', async () => {
    const cp = controlPlane();
    let installed = '';
    const platformCp: ControlPlane = Object.assign(Object.create(Object.getPrototypeOf(cp)), cp, {
      installDataProtection: async (id: string) => {
        installed = await cp.getDataProtectionSql(id);
        return { database: 'app_db', appRole: 'app_runtime' };
      },
    });
    const { call } = await connect(platformCp);
    const created = await call('auth_create_project', { name: 'DP Platform App' });
    const projectId = /BASALT_PROJECT_ID=(prj_\w+)/.exec(created.text)![1]!;
    const r = await call('auth_enable_data_protection', { projectId });
    expect(installed).toContain('basalt_auth.keys');
    expect(r.text).not.toContain('basalt_auth.keys');
    expect(r.text).not.toMatch(/\\x[0-9a-f]{20}/);
    expect(r.text).toContain('app_runtime');
  });

  it('cannot fetch another workspace\'s install SQL', async () => {
    const alice = await connect(controlPlane('ws_alice_dp'));
    const created = await alice.call('auth_create_project', { name: 'Alice DP' });
    const projectId = /BASALT_PROJECT_ID=(prj_\w+)/.exec(created.text)![1]!;
    const mallory = await connect(controlPlane('ws_mallory_dp'));
    const r = await mallory.call('auth_enable_data_protection', { projectId });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain('basalt_auth');
  });
});

describe('code review', () => {
  it('flags attempts to weaken database-enforced ownership', () => {
    const migration = `ALTER TABLE todos DISABLE ROW LEVEL SECURITY;\nALTER ROLE app BYPASSRLS;\nDROP POLICY basalt_owner ON todos;`;
    const rules = new Set(reviewCode(migration, 'migrations/003.sql').map((f) => f.rule));
    expect(rules).toContain('rls-disabled');
    expect(rules).toContain('basalt-policy-dropped');
    const leak = `console.log('grant', auth.dataGrant(user));\nawait client.query("SELECT set_config('basalt.grant', $1, true)", [g]);`;
    const leakRules = new Set(reviewCode(leak, 'server/db.ts').map((f) => f.rule));
    expect(leakRules).toContain('data-grant-leak');
    expect(leakRules).toContain('manual-grant-setting');
  });

  it('flags the classic mistakes', () => {
    const bad = `
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
const SECRET = 'bslt_sk_abcdefghijklmnopqrstuvwxyz0123456789';
app.use(cors({ origin: true, credentials: true }));
app.post('/api/todos', async (req, res) => {
  const user = jwt.decode(req.headers.authorization);
  await db.todos.insert({ ownerId: req.body.userId });
  if (req.body.isAdmin) grantAll();
  const resetCode = Math.random().toString().slice(2, 8);
});
`;
    const rules = new Set(reviewCode(bad, 'server/index.ts').map((f) => f.rule));
    for (const r of ['hardcoded-secret-key', 'own-jwt-signing', 'own-password-hashing', 'permissive-credentialed-cors', 'jwt-decode-without-verify', 'client-supplied-user-id', 'client-supplied-role', 'insecure-randomness']) {
      expect(rules, r).toContain(r);
    }
    expect(JSON.stringify(reviewCode(bad))).not.toContain('abcdefghijklmnop'); // secrets redacted in output
  });

  it('flags browser-only mistakes only in browser code', () => {
    const client = `'use client';
import { createAuthServer } from '@basalt/auth/server';
localStorage.setItem('token', t);
fetch('/api', { headers: { Authorization: \`Bearer \${token}\` } });
const k = process.env.NEXT_PUBLIC_BASALT_AUTH_SECRET_KEY;`;
    const rules = new Set(reviewCode(client, 'app/page.tsx').map((f) => f.rule));
    for (const r of ['server-sdk-in-client', 'token-in-web-storage', 'manual-authorization-header', 'secret-key-public-env']) expect(rules, r).toContain(r);
    const server = `import { createAuthServer } from '@basalt/auth/server';\nconst auth = createAuthServer({ secretKey: process.env.BASALT_AUTH_SECRET_KEY });`;
    expect(reviewCode(server, 'server/auth.ts')).toEqual([]);
  });

  it('every snippet in every integration guide passes the review (guides never teach a flagged pattern)', () => {
    for (const framework of FRAMEWORKS) {
      const guide = integrationGuide(framework);
      const blocks = [...guide.matchAll(/```(?:ts|tsx|sql)\n([\s\S]*?)```/g)].map((m) => m[1]!);
      if (framework !== 'native') expect(blocks.length, framework).toBeGreaterThan(0);
      for (const block of blocks) {
        const serious = reviewCode(block, framework === 'react' ? 'src/App.tsx' : 'server/index.ts').filter((f) => f.severity === 'critical' || f.severity === 'high');
        expect(serious, `${framework}:\n${block.slice(0, 200)}`).toEqual([]);
      }
    }
  });
});
