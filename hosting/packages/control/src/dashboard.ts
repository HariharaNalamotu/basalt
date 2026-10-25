import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import { ipBucket, isNonPublicAddress, signToken, verifyToken } from '@basalt/host-shared';
import type { Ctx } from './ctx.js';
import { connectorConfig, type ConnectorOs } from './connector.js';
import { connectPage, dashboardPage, hasDashboardUi } from './dashboard-page.js';
import type { EnvRow } from './environments.js';
import { UserError, type Host } from './service.js';

/**
 * The owner's dashboard: one page with how their apps are doing (visitors, speed, errors),
 * what was deployed, what went wrong, and who was blocked for attacking them, in plain words.
 * The owner opens it from a signed link (host_dashboard, or basalt-admin dashboard-link); the
 * link sets a session cookie scoped to /dashboard. Everything is limited to that workspace.
 */

const COOKIE = 'basalt_dash';
const LINK_HOURS = 24;
const SESSION_HOURS = 12;
const MAX_ALLOWLIST = 50;
const BUCKET_V6 = /^[0-9a-f]{4}(:[0-9a-f]{4}){3}::\/64$/;

type Detail = {
  totals: { requests: number; status: Record<string, number>; blocked: Record<string, number>; latencyMs: Record<string, unknown>; lastRequestAt: number | null };
  latencyBuckets: Array<{ upToMs: number | null; count: number }>;
  series: Array<[number, number, number, number, number, number, number]>;
  visitors: { perHour: Array<[number, number]>; last24h: number };
  pages: Array<{ key: string; count: number }>;
  api: Array<{ key: string; count: number }>;
  referrers: Array<{ key: string; count: number }>;
  devices: Record<string, number>;
  browsers: Record<string, number>;
  access: Array<{ at: number; method: string; path: string; status: number; ms: number; ip: string; device: string; blocked?: string; allowed?: boolean }>;
};
type SecurityEvent = { at: number; host: string; ip: string; reason: string; method: string; path: string; status: number; allowed?: boolean; banned?: boolean };
type Ban = { ip: string; until: string; bans: number; since: string | null; reason: string | null; host: string | null };

export interface Incident {
  id: string;
  at: string;
  severity: 'critical' | 'warning' | 'info';
  kind: 'outage' | 'errors' | 'deploy' | 'security';
  title: string;
  detail: string;
  app: string;
  env: string;
  ongoing: boolean;
}

/**
 * Minutes where the server errors stood out: at least 3 errors and a fifth of the requests.
 * Neighbouring minutes merge into one spike.
 */
export function errorSpikes(series: Detail['series'], now = Date.now()) {
  const spikes: Array<{ from: number; to: number; errors: number; requests: number }> = [];
  for (const [t, r, , , s5] of series) {
    if (s5 < 3 || s5 / r < 0.2) continue;
    const last = spikes.at(-1);
    if (last && t - last.to <= 2 * 60_000) {
      last.to = t;
      last.errors += s5;
      last.requests += r;
    } else spikes.push({ from: t, to: t, errors: s5, requests: r });
  }
  return spikes.map((s) => ({ ...s, ongoing: now - s.to < 3 * 60_000 }));
}

const dashboardKey = (cfg: Ctx['cfg']) => createHmac('sha256', cfg.masterKey).update('basalt-dashboard-v1').digest('base64url');

/** A link that opens the owner's dashboard (valid for a day; the session it starts lasts 12 hours). */
export function dashboardLink(cfg: Ctx['cfg'], ws: string, next?: 'connect') {
  const t = signToken(dashboardKey(cfg), { ws, kind: 'link', ...(next ? { next } : {}), exp: Math.floor(Date.now() / 1000) + LINK_HOURS * 3600 });
  return `${cfg.hostPublicUrl}/dashboard/open?t=${t}`;
}

const envName = (e: EnvRow) => (e.kind === 'preview' ? e.slug : e.kind);
const iso = (d: Date | string | number) => new Date(d).toISOString();

export function createDashboard(ctx: Ctx, host: Host) {
  const app = new Hono();
  const key = dashboardKey(ctx.cfg);
  const secure = ctx.cfg.PUBLIC_SCHEME === 'https';

  const edge = async <T>(path: string, init: { method?: string } = {}): Promise<T | null> => {
    try {
      const res = await fetch(`${ctx.cfg.EDGE_ADMIN_URL}${path}`, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${ctx.cfg.INTERNAL_TOKEN}` }, signal: AbortSignal.timeout(3000) });
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    }
  };

  const session = (c: Context): string | null => {
    const raw = c.req.header('cookie') ?? '';
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(raw);
    const p = verifyToken<{ ws: string; kind: string; exp: number }>(key, m?.[1]);
    return p?.kind === 'session' ? p.ws : null;
  };

  /** The viewer's address as the edge would see it: through the edge, its x-forwarded-for. */
  const viewerIp = (c: Context): string | null => {
    let remote: string | undefined;
    try {
      remote = getConnInfo(c).remote.address?.replace(/^::ffff:/, '');
    } catch {
      remote = undefined;
    }
    const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    // Only the edge (on the private platform network) can put x-forwarded-for in front of us.
    if (xff && isIP(xff) && remote && isNonPublicAddress(remote)) return xff;
    return remote ?? null;
  };

  const securityHeaders = (nonce?: string) => ({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    ...(nonce
      ? { 'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` }
      : {}),
  });

  // ------------------------------------------------------------------ sign-in from the owner's link
  app.get('/open', (c) => {
    const p = verifyToken<{ ws: string; kind: string; next?: string; exp: number }>(key, c.req.query('t'));
    if (!p || p.kind !== 'link') {
      return c.html('<!doctype html><title>Link expired</title><p style="font:16px system-ui;margin:40px">This dashboard link has expired. Ask Claude for a new one ("show me my dashboard").</p>', 403, securityHeaders());
    }
    const token = signToken(key, { ws: p.ws, kind: 'session', exp: Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600 });
    return c.body(null, 303, {
      ...securityHeaders(),
      location: p.next === 'connect' ? '/dashboard/connect' : '/dashboard',
      'set-cookie': `${COOKIE}=${token}; Path=/dashboard; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}${secure ? '; Secure' : ''}`,
    });
  });

  const signedOut = '<!doctype html><title>Basalt dashboard</title><p style="font:16px system-ui;margin:40px">Open your dashboard from the link Claude gave you (or run the start script again). Ask Claude "show me my dashboard" for a fresh one.</p>';

  // Connect Claude: download the connector file that lets a coding agent build and host here.
  app.get('/connect', (c) => {
    if (!session(c)) return c.html(signedOut, 401, securityHeaders());
    const nonce = randomBytes(16).toString('base64');
    return c.html(connectPage(nonce, { windowsLoopback: Boolean(ctx.cfg.registryLoopbackUrl), hasDashboard: hasDashboardUi() }), 200, securityHeaders(nonce));
  });

  app.get('/', (c) => {
    const nonce = randomBytes(16).toString('base64');
    if (session(c) && !hasDashboardUi()) return c.redirect('/dashboard/connect', 303);
    if (!session(c)) return c.html('<!doctype html><title>Basalt dashboard</title><p style="font:16px system-ui;margin:40px">Open your dashboard from the link Claude gave you. Ask Claude "show me my dashboard" for a fresh one.</p>', 401, securityHeaders());
    return c.html(dashboardPage(nonce), 200, securityHeaders(nonce));
  });

  // ------------------------------------------------------------------ API (session cookie)
  const api = new Hono<{ Variables: { ws: string } }>();
  api.use('*', async (c, next) => {
    const ws = session(c);
    if (!ws) return c.json({ error: 'Your dashboard session ended. Open a fresh link from Claude.' }, 401);
    if (c.req.method !== 'GET') {
      // Changes only from the page itself: a custom header and JSON can't come from another site.
      const origin = c.req.header('origin');
      const self = c.req.header('x-forwarded-host') ?? c.req.header('host');
      if (c.req.header('x-basalt-dashboard') !== '1' || !(c.req.header('content-type') ?? '').startsWith('application/json') || (origin && new URL(origin).host !== self)) {
        return c.json({ error: 'Refused.' }, 403);
      }
    }
    c.set('ws', ws);
    await next();
  });

  async function workspaceEnvs(ws: string) {
    return (
      await ctx.db.query<EnvRow & { app_name: string }>(
        `SELECT e.*, a.name AS app_name FROM environments e JOIN apps a ON a.id = e.app_id WHERE a.workspace_id = $1 AND e.status <> 'deleting' ORDER BY a.created_at, CASE e.kind WHEN 'production' THEN 0 WHEN 'staging' THEN 1 ELSE 2 END, e.created_at`,
        [ws],
      )
    ).rows;
  }

  async function security(ws: string, hosts: string[]) {
    const sec = await edge<{ events: SecurityEvent[]; bans: Ban[] }>(`/security?hosts=${encodeURIComponent(hosts.join(','))}`);
    const events = sec?.events ?? [];
    const seen = new Set(events.map((e) => e.ip));
    const mine = new Set(hosts);
    // Bans that touched this owner's apps: started on one, or that client attacked one.
    const bans = (sec?.bans ?? []).filter((b) => (b.host && mine.has(b.host)) || seen.has(b.ip));
    const allowlist = (await ctx.db.query<{ ip: string; label: string; created_at: Date }>('SELECT ip, label, created_at FROM allowlist WHERE workspace_id = $1 ORDER BY created_at', [ws])).rows.map((r) => ({ ip: r.ip, label: r.label, addedAt: iso(r.created_at) }));
    return { events, bans, allowlist, edgeReachable: sec !== null };
  }

  api.get('/state', async (c) => {
    const ws = c.get('ws');
    const envs = await workspaceEnvs(ws);
    const details = new Map<string, Detail | null>();
    await Promise.all(envs.map(async (e) => details.set(e.id, (await edge<{ detail: Detail | null }>(`/detail?host=${encodeURIComponent(e.host)}`))?.detail ?? null)));

    // Which environment the page is looking at: asked for, else the first app's production.
    const wantApp = c.req.query('app');
    const wantEnv = c.req.query('env');
    const selected = envs.find((e) => e.app_name === wantApp && envName(e) === wantEnv) ?? envs.find((e) => e.app_name === wantApp) ?? envs.find((e) => e.kind === 'production') ?? envs[0];

    const containers = new Map<string, { state: string; health?: string; restarts: number; startedAt: string } | null>();
    await Promise.all(
      envs.map(async (e) => {
        const rel = await host.runtime.liveRelease(e);
        const info = rel?.container ? await ctx.docker.inspectOrNull(rel.container).catch(() => null) : null;
        containers.set(e.id, info ? { state: info.State.Status, health: info.State.Health?.Status, restarts: info.RestartCount, startedAt: info.State.StartedAt } : null);
      }),
    );

    const status = (e: EnvRow): 'up' | 'sleeping' | 'down' | 'starting' | 'not_deployed' => {
      if (!e.current_release_id) return e.status === 'ready' ? 'not_deployed' : 'starting';
      if (e.sleeping) return 'sleeping';
      const k = containers.get(e.id);
      if (k && (k.state !== 'running' || k.health === 'unhealthy')) return 'down';
      if (e.status !== 'ready') return 'starting';
      return 'up';
    };

    const sum = (d: Detail | null, i: number) => (d ? d.series.reduce((a, row) => a + (row[i] as number), 0) : 0);
    const apps: Record<string, { name: string; environments: unknown[] }> = {};
    for (const e of envs) {
      const d = details.get(e.id) ?? null;
      const hourNow = Math.floor(Date.now() / 3_600_000);
      const spark = Array.from({ length: 24 }, (_, i) => {
        const from = (hourNow - 23 + i) * 3_600_000;
        return d ? d.series.filter(([t]) => t >= from && t < from + 3_600_000).reduce((a, r) => a + r[1], 0) : 0;
      });
      (apps[e.app_name] ??= { name: e.app_name, environments: [] }).environments.push({
        name: envName(e),
        kind: e.kind,
        url: ctx.cfg.appUrl(e.host),
        status: status(e),
        requests24h: sum(d, 1),
        errors24h: sum(d, 4),
        blocked24h: sum(d, 5),
        visitors24h: d?.visitors.last24h ?? 0,
        lastRequestAt: d?.totals.lastRequestAt ?? null,
        spark,
        expiresAt: e.expires_at,
      });
    }

    const hosts = envs.map((e) => e.host);
    const hostToEnv = new Map(envs.map((e) => [e.host, { app: e.app_name, env: envName(e) }]));
    const sec = await security(ws, hosts);
    const incidents = await buildIncidents(envs, details, containers, sec.bans);

    let sel: unknown = null;
    if (selected) {
      const d = details.get(selected.id) ?? null;
      const k = containers.get(selected.id) ?? null;
      const releases = (await host.runtime.releases(selected.id, 10)).map((r) => ({ id: r.id, deploymentId: r.deployment_id, status: r.status, reason: r.reason, createdAt: r.created_at, liveAt: r.live_at, endedAt: r.ended_at, current: r.id === selected.current_release_id }));
      let data: unknown = null;
      if (ctx.cfg.dataLink && selected.data_project_id) data = await host.dataStatus(ws, selected.app_name, envName(selected)).catch(() => null);
      sel = {
        app: selected.app_name,
        env: envName(selected),
        kind: selected.kind,
        url: ctx.cfg.appUrl(selected.host),
        status: status(selected),
        createdAt: selected.created_at,
        expiresAt: selected.expires_at,
        protection: selected.protection,
        backend: k,
        traffic: d,
        releases,
        data,
      };
    }

    const deployments = selected ? await deploymentsFor(selected.app_id) : [];
    const activity = (await ctx.db.query<{ action: string; target: string; data: Record<string, unknown>; created_at: Date }>('SELECT action, target, data, created_at FROM audit WHERE workspace_id = $1 ORDER BY id DESC LIMIT 40', [ws])).rows.map((r) => ({ action: r.action, target: r.target, data: r.data, at: iso(r.created_at) }));
    const ws_ = (await ctx.db.query<{ name: string }>('SELECT name FROM workspaces WHERE id = $1', [ws])).rows[0];
    const you = viewerIp(c);

    return c.json({
      generatedAt: new Date().toISOString(),
      workspace: ws_?.name ?? ws,
      you: you ? { ip: you, bucket: ipBucket(you), allowlisted: sec.allowlist.some((a) => a.ip === ipBucket(you)), banned: sec.bans.some((b) => b.ip === ipBucket(you)) } : null,
      apps: Object.values(apps),
      selected: sel,
      deployments,
      incidents,
      security: {
        edgeReachable: sec.edgeReachable,
        events: sec.events.slice(-300).map((e) => ({ ...e, ...hostToEnv.get(e.host) })),
        bans: sec.bans.map((b) => ({ ...b, ...(b.host ? hostToEnv.get(b.host) : {}) })),
        allowlist: sec.allowlist,
      },
      activity,
    });
  });

  async function deploymentsFor(appId: string) {
    const deps = (await ctx.db.query<{ id: string; status: string; message: string | null; steps: Array<{ name: string; status: string; ms?: number }>; error: string | null; created_at: Date; finished_at: Date | null }>('SELECT id, status, message, steps, error, created_at, finished_at FROM deployments WHERE app_id = $1 ORDER BY created_at DESC LIMIT 15', [appId])).rows;
    if (!deps.length) return [];
    const ids = deps.map((d) => d.id);
    const pipes = (await ctx.db.query<{ deployment_id: string; target: string; status: string; stage: string; log: Array<{ at: string; stage: string; message: string }>; created_at: Date; finished_at: Date | null }>('SELECT deployment_id, target, status, stage, log, created_at, finished_at FROM pipelines WHERE deployment_id = ANY($1) ORDER BY created_at', [ids])).rows;
    const tests = (await ctx.db.query<{ deployment_id: string; kind: string; status: string; summary: Record<string, unknown>; env_kind: string; slug: string; created_at: Date }>('SELECT t.deployment_id, t.kind, t.status, t.summary, e.kind AS env_kind, e.slug, t.created_at FROM test_runs t JOIN environments e ON e.id = t.env_id WHERE t.deployment_id = ANY($1) ORDER BY t.created_at', [ids])).rows;
    const live = (await ctx.db.query<{ deployment_id: string; kind: string; slug: string }>(`SELECT r.deployment_id, e.kind, e.slug FROM environments e JOIN releases r ON r.id = e.current_release_id WHERE r.deployment_id = ANY($1)`, [ids])).rows;
    return deps.map((d) => ({
      id: d.id,
      status: d.status,
      message: d.message,
      error: d.error,
      createdAt: d.created_at,
      finishedAt: d.finished_at,
      steps: d.steps.map((s) => ({ name: s.name, status: s.status, ms: s.ms })),
      pipelines: pipes.filter((p) => p.deployment_id === d.id).map((p) => ({ target: p.target, status: p.status, stage: p.stage, log: p.log.slice(-12).map((l) => ({ ...l, message: l.message.slice(0, 600) })), createdAt: p.created_at, finishedAt: p.finished_at })),
      tests: tests
        .filter((t) => t.deployment_id === d.id)
        .map((t) => {
          const s = t.summary as { passed?: number; failed?: number; checks?: unknown[]; receiptUrl?: string };
          return { kind: t.kind, status: t.status, env: t.env_kind === 'preview' ? t.slug : t.env_kind, passed: typeof s.passed === 'number' ? s.passed : undefined, failed: typeof s.failed === 'number' ? s.failed : undefined, receiptUrl: typeof s.receiptUrl === 'string' ? s.receiptUrl : undefined, at: t.created_at };
        }),
      liveIn: live.filter((l) => l.deployment_id === d.id).map((l) => (l.kind === 'preview' ? l.slug : l.kind)),
    }));
  }

  async function buildIncidents(envs: Array<EnvRow & { app_name: string }>, details: Map<string, Detail | null>, containers: Map<string, { state: string; health?: string; restarts: number } | null>, bans: Ban[]): Promise<Incident[]> {
    const out: Incident[] = [];
    const byId = new Map(envs.map((e) => [e.id, e]));
    const byHost = new Map(envs.map((e) => [e.host, e]));
    const since = new Date(Date.now() - 7 * 86_400_000);

    for (const e of envs) {
      const k = containers.get(e.id);
      if (e.current_release_id && !e.sleeping && k && (k.state !== 'running' || k.health === 'unhealthy')) {
        out.push({ id: `down-${e.id}`, at: iso(Date.now()), severity: 'critical', kind: 'outage', title: 'The app\'s server is not answering', detail: `Its server is ${k.health === 'unhealthy' ? 'failing its health checks' : k.state}. Pages may still load, but anything that saves or loads data can fail. Ask Claude to look at the logs.`, app: e.app_name, env: envName(e), ongoing: true });
      }
      for (const s of errorSpikes(details.get(e.id)?.series ?? [])) {
        out.push({ id: `spike-${e.id}-${s.from}`, at: iso(s.from), severity: e.kind === 'production' ? 'critical' : 'warning', kind: 'errors', title: s.ongoing ? 'Visitors are seeing errors right now' : 'Visitors saw a burst of errors', detail: `${s.errors} of ${s.requests} requests failed with a server error between ${new Date(s.from).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} and ${new Date(s.to + 60_000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} (UTC).`, app: e.app_name, env: envName(e), ongoing: s.ongoing });
      }
    }

    const ids = envs.map((e) => e.id);
    if (ids.length) {
      const rels = (await ctx.db.query<{ id: string; env_id: string; status: string; reason: string | null; created_at: Date; ended_at: Date | null }>(`SELECT id, env_id, status, reason, created_at, ended_at FROM releases WHERE env_id = ANY($1) AND created_at > $2 AND (status = 'failed' OR reason LIKE 'automatic:%') ORDER BY created_at DESC LIMIT 50`, [ids, since])).rows;
      for (const r of rels) {
        const e = byId.get(r.env_id)!;
        if (r.reason?.startsWith('automatic:')) {
          out.push({ id: `rollback-${r.id}`, at: iso(r.ended_at ?? r.created_at), severity: e.kind === 'production' ? 'critical' : 'warning', kind: 'outage', title: 'A new version was taken down automatically', detail: `Basalt put the previous version back because of ${r.reason.replace(/^automatic:\s*/, '')}. Visitors are on the last good version.`, app: e.app_name, env: envName(e), ongoing: false });
        } else if (r.reason !== 'interrupted') {
          out.push({ id: `relfail-${r.id}`, at: iso(r.ended_at ?? r.created_at), severity: 'warning', kind: 'deploy', title: 'A new version failed to start', detail: `${(r.reason ?? 'It did not start.').split('\n')[0]!.slice(0, 300)} The previous version kept running.`, app: e.app_name, env: envName(e), ongoing: false });
        }
      }
      const guards = (await ctx.db.query<{ env_id: string; deployment_id: string; summary: { failures?: Array<{ title: string }>; receiptUrl?: string }; created_at: Date }>(`SELECT env_id, deployment_id, summary, created_at FROM test_runs WHERE env_id = ANY($1) AND kind = 'guard' AND status = 'failed' AND created_at > $2 ORDER BY created_at DESC LIMIT 20`, [ids, since])).rows;
      for (const g of guards) {
        const e = byId.get(g.env_id)!;
        out.push({ id: `guard-${g.deployment_id}-${g.env_id}`, at: iso(g.created_at), severity: 'critical', kind: 'security', title: 'Guard found data the wrong people could reach', detail: `${g.summary.failures?.map((f) => f.title).join('; ') ?? 'A check got through.'} That version was stopped before going further.`, app: e.app_name, env: envName(e), ongoing: false });
      }
    }
    const appIds = [...new Set(envs.map((e) => e.app_id))];
    if (appIds.length) {
      const failed = (await ctx.db.query<{ id: string; app_id: string; error: string | null; steps: Array<{ name: string; status: string }>; created_at: Date; finished_at: Date | null }>(`SELECT id, app_id, error, steps, created_at, finished_at FROM deployments WHERE app_id = ANY($1) AND status = 'failed' AND created_at > $2 ORDER BY created_at DESC LIMIT 20`, [appIds, since])).rows;
      const appName = new Map(envs.map((e) => [e.app_id, e.app_name]));
      for (const d of failed) {
        const step = d.steps.find((s) => s.status === 'failed')?.name;
        out.push({ id: `deploy-${d.id}`, at: iso(d.finished_at ?? d.created_at), severity: 'info', kind: 'deploy', title: 'An update didn\'t pass its checks', detail: `${step ? `It stopped at "${step}". ` : ''}${(d.error ?? '').split('\n')[0]!.slice(0, 240)} Nothing changed for visitors.`, app: appName.get(d.app_id) ?? '', env: 'build', ongoing: false });
      }
    }
    for (const b of bans) {
      const e = b.host ? byHost.get(b.host) : undefined;
      out.push({ id: `ban-${b.ip}-${b.since}`, at: b.since ?? iso(Date.now()), severity: 'info', kind: 'security', title: 'An attacker was blocked', detail: `${b.ip} was blocked until ${new Date(b.until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} (UTC) after ${b.reason ? `"${b.reason}"` : 'repeated attacks'}${b.bans > 1 ? `. Blocked ${b.bans} times so far` : ''}.`, app: e?.app_name ?? '', env: e ? envName(e) : '', ongoing: true });
    }
    return out.sort((a, b) => Number(b.ongoing) - Number(a.ongoing) || b.at.localeCompare(a.at));
  }

  api.get('/logs', async (c) => {
    const ws = c.get('ws');
    const appName = c.req.query('app') ?? '';
    const env = c.req.query('env') ?? '';
    const text = await host.logs(ws, appName, env, { tail: 300, grep: c.req.query('q')?.slice(0, 100) || undefined });
    const lines = text
      .split('\n')
      .filter(Boolean)
      .map((raw) => {
        try {
          const j = JSON.parse(raw.replace(/^\S+Z\s/, '')) as Record<string, unknown>;
          return { at: typeof j.time === 'string' ? j.time : typeof j.ts === 'string' ? j.ts : null, level: String(j.level ?? 'info'), message: String(j.msg ?? j.message ?? j.event ?? ''), raw };
        } catch {
          return { at: null, level: /error|fail|exception/i.test(raw) ? 'error' : 'info', message: raw, raw };
        }
      });
    return c.json({ lines });
  });

  const parseIp = (v: unknown): string => {
    const s = String(v ?? '').trim().toLowerCase();
    if (BUCKET_V6.test(s)) return s;
    if (!isIP(s)) throw new UserError('That is not an IP address.');
    return ipBucket(s);
  };

  api.post('/allowlist', async (c) => {
    const ws = c.get('ws');
    const body = (await c.req.json().catch(() => ({}))) as { ip?: string; label?: string };
    const ip = parseIp(body.ip);
    const label = String(body.label ?? '').slice(0, 80);
    const n = (await ctx.db.query<{ n: string }>('SELECT count(*) AS n FROM allowlist WHERE workspace_id = $1', [ws])).rows[0]!;
    if (Number(n.n) >= MAX_ALLOWLIST) throw new UserError(`You can always-allow up to ${MAX_ALLOWLIST} addresses. Remove one first.`);
    await ctx.db.query('INSERT INTO allowlist (workspace_id, ip, label) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, ip) DO UPDATE SET label = EXCLUDED.label', [ws, ip, label]);
    await unbanIfMine(ws, ip);
    await ctx.db.query('INSERT INTO audit (workspace_id, action, target, data) VALUES ($1, $2, $3, $4)', [ws, 'allowlist.added', ip, JSON.stringify({ label })]);
    await (ctx.routes.sync?.() ?? ctx.routes.bump());
    return c.json({ ok: true, ip });
  });

  api.delete('/allowlist', async (c) => {
    const ws = c.get('ws');
    const body = (await c.req.json().catch(() => ({}))) as { ip?: string };
    const ip = parseIp(body.ip);
    await ctx.db.query('DELETE FROM allowlist WHERE workspace_id = $1 AND ip = $2', [ws, ip]);
    await ctx.db.query('INSERT INTO audit (workspace_id, action, target) VALUES ($1, $2, $3)', [ws, 'allowlist.removed', ip]);
    await (ctx.routes.sync?.() ?? ctx.routes.bump());
    return c.json({ ok: true });
  });

  api.post('/unban', async (c) => {
    const ws = c.get('ws');
    const body = (await c.req.json().catch(() => ({}))) as { ip?: string };
    const ip = parseIp(body.ip);
    if (!(await unbanIfMine(ws, ip))) throw new UserError('That address is not blocked on your apps.', 404);
    await ctx.db.query('INSERT INTO audit (workspace_id, action, target) VALUES ($1, $2, $3)', [ws, 'ban.lifted', ip]);
    return c.json({ ok: true });
  });

  /** Lifts a ban only when it involves this owner's apps; other owners' bans stay. */
  async function unbanIfMine(ws: string, ip: string) {
    const hosts = (await workspaceEnvs(ws)).map((e) => e.host);
    const sec = await security(ws, hosts);
    if (!sec.bans.some((b) => b.ip === ip)) return false;
    await edge(`/bans?ip=${encodeURIComponent(ip)}`, { method: 'DELETE' });
    return true;
  }

  // A fresh workspace token inside a ready .mcp.json. POST (from the page), so a link elsewhere
  // can't mint tokens; the file is the only place the token is ever shown.
  api.post('/connector', async (c) => {
    const ws = c.get('ws');
    const body = (await c.req.json().catch(() => ({}))) as { os?: string };
    const os: ConnectorOs = body.os === 'windows' ? 'windows' : body.os === 'linux' ? 'linux' : 'mac';
    const token = await host.createToken(ws, `connector (${os}, downloaded)`);
    return c.body(JSON.stringify(connectorConfig(ctx.cfg, token, os), null, 2) + '\n', 200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename=".mcp.json"',
      'cache-control': 'no-store',
    });
  });

  app.route('/api', api);
  app.onError((err, c) => {
    const status = err instanceof UserError ? err.status : 500;
    if (status >= 500) ctx.log.error('dashboard_error', { err });
    return c.json({ error: status === 500 ? 'Something went wrong loading the dashboard.' : err.message }, status as 400);
  });

  return app;
}
