import { describe, expect, it } from 'vitest';
import { verifyToken } from '@basalt/host-shared';
import { loadConfig } from '../src/config.js';
import { connectorConfig } from '../src/connector.js';
import { dashboardLink, errorSpikes } from '../src/dashboard.js';

const base = { ROOT_DOMAIN: 'basalt.localhost', DATABASE_URL: 'postgres://x', PG_ADMIN_URL: 'postgres://x', REDIS_ADMIN_URL: 'redis://x', AUTH_PUBLIC_URL: 'https://auth.basalt.localhost', AUTH_PLATFORM_KEY: 'k'.repeat(32), MASTER_KEY: Buffer.alloc(32, 1).toString('base64'), INTERNAL_TOKEN: 't'.repeat(32), MAIL_WEBHOOK_SECRET: 'm'.repeat(32) };
const demo = loadConfig({ ...base, PUBLIC_SCHEME: 'http', PUBLIC_PORT: '8080', HOST_PUBLIC_URL: 'http://127.0.0.1:4000', REGISTRY_PUBLIC_URL: 'http://registry.basalt.localhost:8080/', REGISTRY_LOOPBACK_URL: 'http://127.0.0.1:4873' });

describe('connector file', () => {
  it('Mac and Linux run npx from the platform registry', () => {
    const s = connectorConfig(demo, 'bht_x', 'mac').mcpServers.basalt;
    expect(s.command).toBe('npx');
    expect(s.args).toEqual(['-y', '--registry', 'http://registry.basalt.localhost:8080/', '@basalt/host-mcp']);
    expect(s.env).toEqual({ BASALT_HOST_URL: 'http://127.0.0.1:4000', BASALT_HOST_TOKEN: 'bht_x', BASALT_ROOT_DOMAIN: 'basalt.localhost', BASALT_REGISTRY_URL: 'http://registry.basalt.localhost:8080/' });
  });

  it('Windows wraps npx in cmd /c and uses the loopback registry (no *.localhost outside browsers)', () => {
    const s = connectorConfig(demo, 'bht_x', 'windows').mcpServers.basalt;
    expect(s.command).toBe('cmd');
    expect(s.args).toEqual(['/c', 'npx', '-y', '--registry', 'http://127.0.0.1:4873/', '@basalt/host-mcp']);
    expect(s.env.BASALT_REGISTRY_URL).toBe('http://127.0.0.1:4873/');
  });

  it('a real server gives Windows the public registry too', () => {
    const prod = loadConfig(base);
    expect(connectorConfig(prod, 'bht_x', 'windows').mcpServers.basalt.env.BASALT_REGISTRY_URL).toBe('https://registry.basalt.localhost/');
  });
});

describe('dashboard', () => {
  it('links are signed for one workspace, and can open on Connect Claude', () => {
    const url = new URL(dashboardLink(demo, 'ws_abc', 'connect'));
    expect(url.origin + url.pathname).toBe('http://127.0.0.1:4000/dashboard/open');
    const t = url.searchParams.get('t')!;
    expect(verifyToken<{ ws: string; kind: string; next: string; exp: number }>('wrong-key', t)).toBeNull();
    const body = JSON.parse(Buffer.from(t.split('.')[0]!, 'base64url').toString()) as { ws: string; kind: string; next: string; exp: number };
    expect(body).toMatchObject({ ws: 'ws_abc', kind: 'link', next: 'connect' });
    expect(body.exp * 1000 - Date.now()).toBeGreaterThan(23 * 3600_000);
  });

  it('error spikes: bursts of server errors merge, a few stray errors do not count', () => {
    const now = Date.UTC(2026, 9, 24, 12, 0);
    const m = (minAgo: number, r: number, s5: number) => [now - minAgo * 60_000, r, r - s5, 0, s5, 0, 20] as [number, number, number, number, number, number, number];
    const spikes = errorSpikes([m(30, 100, 2), m(20, 10, 5), m(19, 10, 6), m(1, 8, 4)], now);
    expect(spikes).toHaveLength(2);
    expect(spikes[0]).toMatchObject({ errors: 11, requests: 20, ongoing: false });
    expect(spikes[1]).toMatchObject({ errors: 4, ongoing: true });
  });
});
