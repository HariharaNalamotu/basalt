import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerApiTools } from '@basalt/api-mcp';
import { registerAuthTools } from '@basalt/auth-mcp';
import type { Ctx } from './ctx.js';
import { dashboardLink } from './dashboard.js';
import { GUIDE_TOPICS, hostGuide } from './guides.js';
import { emailsReadable } from './naming.js';
import type { Host } from './service.js';
import { DELETION_HOURS, UserError } from './service.js';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };

const text = (t: string): Result => ({ content: [{ type: 'text', text: t }] });
const json = (v: unknown, note?: string): Result => text(`${note ? `${note}\n\n` : ''}${JSON.stringify(v, null, 2)}`);
async function run(fn: () => Promise<Result>): Promise<Result> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (err as Error).message;
    return { isError: true, content: [{ type: 'text', text: `Error: ${msg}` }] };
  }
}

const app = z.string().describe('App name (lowercase, e.g. "todo-app").');
const env = z.string().describe('"staging", "production", or a preview name like "p3f9a1x" (see host_status).');
const testEnv = z.string().describe('"staging" or a preview name like "p3f9a1x". Production is never driven by tools.');
const session = z.string().uuid().describe('Browser session id from browser_open.');
const target = z
  .object({
    role: z.string().optional().describe('ARIA role, e.g. "button", "link", "textbox", "heading", "checkbox".'),
    name: z.string().optional().describe('Accessible name used with role, e.g. "Sign in".'),
    label: z.string().optional(),
    placeholder: z.string().optional(),
    text: z.string().optional(),
    testId: z.string().optional(),
    selector: z.string().optional().describe('CSS selector (last resort).'),
    exact: z.boolean().optional(),
    nth: z.number().int().min(0).optional(),
  })
  .describe('How to find the element. Prefer role+name from the snapshot, then label/placeholder/text.');

/** Builds the MCP server for one authenticated workspace. */
export function createMcpServer(ctx: Ctx, host: Host, ws: string): McpServer {
  const server = new McpServer(
    { name: 'basalt-host', version: '0.1.0' },
    {
      instructions:
        'Basalt Host builds, tests, stages and ships apps. Workflow: host_guide "workflow" → write code following api_integration_guide / auth_integration_guide (and host_guide "data" for anything the app saves) → host_deploy (local tool; builds, deploys a private preview and runs tests) → fix anything failing (host_deployment, host_logs, browser_* tools) → host_data_check → host_promote to staging → host_promote to production (only after staging tests pass). Never ask the user to do anything the tools can do.',
    },
  );
  const browser = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await fetch(`${ctx.cfg.BROWSER_URL}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${ctx.cfg.INTERNAL_TOKEN}`, 'x-basalt-owner': ws, 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new UserError(String(body.error ?? `browser error ${res.status}`));
    return body;
  };
  const act = (id: string, action: Record<string, unknown>) => browser(`/sessions/${id}/act`, { method: 'POST', body: action });
  const page = (r: Record<string, unknown>) => text([`URL: ${r.url ?? ''}`, r.title ? `Title: ${r.title}` : '', r.status ? `HTTP ${r.status}` : '', r.snapshot ? `\nPage (accessibility snapshot):\n${r.snapshot}` : ''].filter(Boolean).join('\n'));

  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (a: z.infer<z.ZodObject<S>>) => Promise<Result>, annotations: Record<string, boolean> = {}) =>
    server.registerTool(name, { description, inputSchema: shape, annotations }, ((a: z.infer<z.ZodObject<S>>) => run(() => fn(a))) as never);

  // ---------------------------------------------------------------- overview & guides
  tool('host_guide', `How to build, test and ship on Basalt Host. Topics: ${GUIDE_TOPICS.join(', ')}. Read "workflow" first.`, { topic: z.enum(GUIDE_TOPICS) }, async ({ topic }) => text(hostGuide(topic, ctx.cfg.ROOT_DOMAIN, ctx.cfg.registryPublicUrl)), { readOnlyHint: true });
  tool('host_status', 'All apps in this workspace with every environment, its URL, state and current release.', {}, async () => json(await host.listApps(ws)), { readOnlyHint: true });
  tool('host_create_app', 'Creates an app (reserves <app>.' + ctx.cfg.ROOT_DOMAIN + '). Idempotent for your own apps.', { app }, async (a) => {
    const r = await host.createApp(ws, a.app);
    return text(`App "${r.name}" ready. Production URL will be ${ctx.cfg.appUrl(`${r.name}.${ctx.cfg.ROOT_DOMAIN}`)}. Next: host_deploy.`);
  });

  // ---------------------------------------------------------------- deploy pipeline
  tool(
    'host_deploy_source',
    'Starts a deployment from an uploaded source (host_deploy uploads and calls this for you). ship=false: build → private preview → smoke + e2e tests. ship=true: continues to staging (tests) and production.',
    { app, sourceId: z.string().regex(/^[0-9a-f]{64}$/), message: z.string().max(500).optional(), ship: z.boolean().optional() },
    async (a) => {
      const r = await host.deploy(ws, a.app, a.sourceId, { message: a.message, target: a.ship ? 'production' : 'preview' });
      const s = await host.waitFor(ws, r.deploymentId, 40_000);
      return json(s, s.done ? 'Finished.' : `Still running. Call host_wait with deploymentId ${r.deploymentId}.`);
    },
  );
  tool('host_wait', 'Waits (up to ~45s) for a deployment pipeline to progress, then returns its status. Call repeatedly until done.', { deploymentId: z.string() }, async (a) => {
    const s = await host.waitFor(ws, a.deploymentId, 45_000);
    return json(s, s.done ? 'Finished.' : 'Still running; call host_wait again.');
  }, { readOnlyHint: true });
  tool('host_deployment', 'Full status of a deployment: CI steps (with output of failed steps), pipeline log, test results, where it is live.', { deploymentId: z.string() }, async (a) => json(await host.deploymentStatus(ws, a.deploymentId)), { readOnlyHint: true });
  tool('host_build_logs', 'Complete output of one CI step (install, audit, typecheck, lint, unit-tests, build, package, security-scan).', { deploymentId: z.string(), step: z.string() }, async (a) => {
    const d = await host.deployment(ws, a.deploymentId);
    const s = d.steps.find((x) => x.name === a.step);
    return text(s ? `${s.name}: ${s.status}\n\n${s.output ?? '(no output)'}` : `No step "${a.step}". Steps: ${d.steps.map((x) => x.name).join(', ')}`);
  }, { readOnlyHint: true });
  tool(
    'host_promote',
    'Promotes a built deployment. to="staging": deploys and runs smoke + e2e tests (poll host_wait). to="production": zero-downtime release; requires the deployment to have passed its tests in staging; production smoke test failure rolls back automatically, and errors in the next 3 minutes trigger automatic rollback.',
    { app, deploymentId: z.string(), to: z.enum(['staging', 'production']) },
    async (a) => json(await host.promote(ws, a.app, a.deploymentId, a.to)),
  );
  tool('host_rollback', 'Instantly rolls an environment back to the previous release (or a specific releaseId from host_releases).', { app, env, releaseId: z.string().optional() }, async (a) => {
    const { app: ap, env: e } = await host.env(ws, a.app, a.env);
    return json(await host.runtime.rollback(ap, e, a.releaseId), 'Rolled back.');
  }, { destructiveHint: true });
  tool('host_releases', 'Release history of an environment (what was live when, and why releases ended).', { app, env }, async (a) => {
    const { env: e } = await host.env(ws, a.app, a.env);
    return json(await host.runtime.releases(e.id));
  }, { readOnlyHint: true });

  // ---------------------------------------------------------------- observability
  tool('host_logs', 'Backend logs of an environment (JSON lines from @basalt/api, newest last).', { app, env, tail: z.number().int().min(1).max(2000).optional(), sinceMinutes: z.number().int().min(1).max(1440).optional(), grep: z.string().max(100).optional() }, async (a) => text(await host.logs(ws, a.app, a.env, a)), { readOnlyHint: true });
  tool(
    'host_dashboard',
    'A link to the owner\'s dashboard: visitors, speed, errors, deployments, incidents and blocked attackers for every app, in plain words, with an "always allow" list for their own computer. Give it to the human when they ask how their app is doing, or to see who was blocked. Valid for 24 hours; share it only with the owner.',
    {},
    async () => text(`Dashboard for the owner (valid 24 hours, don't share it publicly):\n${dashboardLink(ctx.cfg, ws)}`),
    { readOnlyHint: true },
  );
  tool('host_metrics', 'Traffic, status codes, latency percentiles, blocked requests (by reason) and backend health for an environment.', { app, env }, async (a) => json(await host.metrics(ws, a.app, a.env)), { readOnlyHint: true });

  // ---------------------------------------------------------------- secrets & configuration
  tool('host_secrets', 'Lists secret NAMES of an environment (values are never shown).', { app, env }, async (a) => json(await host.listSecrets(ws, a.app, a.env)), { readOnlyHint: true });
  tool(
    'host_set_secret',
    'Stores a secret (e.g. STRIPE_SECRET_KEY) encrypted and injects it as an env var; the running release restarts with zero downtime. env="all" sets it in every existing environment (new previews copy staging).',
    { app, env: z.string().describe('"all", "staging", "production" or a preview name.'), name: z.string(), value: z.string() },
    async (a) => json(await host.setSecret(ws, a.app, a.env, a.name, a.value), `Secret ${a.name} set.`),
  );
  tool('host_delete_secret', 'Removes a secret.', { app, env: z.string(), name: z.string() }, async (a) => {
    await host.deleteSecret(ws, a.app, a.env, a.name);
    return text(`Deleted ${a.name}.`);
  }, { destructiveHint: true });
  tool(
    'host_data_rules',
    'Sets what an environment\'s data saves and who can see it (the Basalt Data block, reached from the browser with basalt() at /_basalt/data, or ctx.data in the backend). Each signed-in person only ever reaches their own rows. Rules: { "tables": { "<table>": { "fields": { "<field>": { "type": "text" | "integer" | "number" | "boolean" | "timestamp" | "user" | "file", "required"?: true } }, "shareWith"?: "<user field>" } } }. Preview and staging take the rules right away. Production returns an approval link the human must open and approve before anything changes: show it to them.',
    { app, env, rules: z.record(z.string(), z.unknown()) },
    async (a) => {
      const r = await host.dataRules(ws, a.app, a.env, a.rules);
      return r.status === 'live'
        ? text(`Live. ${r.summary}`)
        : text(`Waiting for the owner. Show them this link and ask them to approve:\n${r.approveUrl}\n\nWhy: ${r.why.join(' ')}\n\n${r.summary}`);
    },
  );
  tool('host_data_status', 'Whether an environment\'s data rules are live or waiting for the owner, the rules in plain English, and the owner\'s data map link (where everything lives and who can reach it; share it only with the owner).', { app, env }, async (a) => {
    const s = await host.dataStatus(ws, a.app, a.env);
    const pending = s.pending.length ? `\n\nWaiting for the owner to approve (show them the links):\n${s.pending.map((p) => `- ${p.label}: ${p.approveUrl}`).join('\n')}` : '';
    if (s.status === 'no_rules') return text(`No data rules yet. Set them with host_data_rules (host_guide "data" explains the format).${pending}`);
    if (s.status === 'waiting_for_owner') return text(pending ? `Waiting for the owner to open the approval link and approve.${pending}` : 'Waiting for the owner to open the approval link and approve. If they lost it, call host_data_rules again for a fresh link.');
    return text(`Live. Rules in plain English:\n${s.rules}${pending}${s.mapUrl ? `\n\nOwner's data map (share only with the owner):\n${s.mapUrl}` : ''}`);
  }, { readOnlyHint: true });
  tool(
    'host_data_admin',
    'Asks the owner to make one person an admin of an environment\'s data (they see and change every row, e.g. a business owner viewing all bookings), or with remove: true to take that away (they only see their own entries again). Always returns an approval link: show it to the human. email = the email a real person signed up in the app with (ask the human for theirs; they must sign up first), who = a test person\'s name (test environments), or userId = a signed-in user\'s id. The owner\'s data map (host_data_status) lists every admin.',
    { app, env, email: z.string().max(254).optional(), who: z.string().regex(/^[A-Za-z0-9 _-]{1,40}$/).optional(), userId: z.string().uuid().optional(), label: z.string().max(60).optional(), remove: z.boolean().optional().describe('true to remove this person as admin instead of adding them.') },
    async ({ app: ap, env: e, remove, ...who }) => {
      if (!who.email && !who.who && !who.userId) throw new UserError('Say who: the email they signed up with (email), a test person\'s name (who) or a user id (userId).');
      const r = await host.dataAdmin(ws, ap, e, who, remove === true);
      return text(
        remove
          ? `The owner needs to approve removing this admin. Show them this link and ask them to open it and approve:\n${r.approveUrl}\n\nOnce they do, this person only sees their own entries again. User id: ${r.userId}`
          : `The owner needs to approve this. Show them this link and ask them to open it and approve:\n${r.approveUrl}\n\nUser id: ${r.userId}`,
      );
    },
  );
  tool(
    'host_data_check',
    'Guard, Basalt\'s safety check for a test environment\'s data, run now: signs in as two real test people and a stranger and tries every way to reach data that isn\'t theirs (opening, listing, changing and archiving someone else\'s entries, forged and expired logins, writes to protected fields, sneaky searches), then returns what got through and the owner\'s safety receipt link. The local version also scans the project folder for data kept outside Basalt. Guard also runs automatically after the tests on every preview and staging deploy of an app with basalt.data.json, and production needs it to pass in staging. Never runs on production.',
    {
      app,
      env: testEnv,
      scan: z
        .array(z.object({ rule: z.string(), file: z.string(), line: z.number().int(), problem: z.string(), fix: z.string() }))
        .max(100)
        .optional()
        .describe('Local code scan findings (the local host_data_check fills this in).'),
    },
    async (a) => {
      const r = await host.dataCheck(ws, a.app, a.env, a.scan ?? null);
      const lines = [`${r.passed} of ${r.passed + r.failed} checks passed.`];
      for (const x of r.failures) lines.push(`PROBLEM, ${x.title}${x.table ? ` (${x.table})` : ''}: ${x.detail}`);
      if (a.scan) {
        if (a.scan.length) {
          lines.push('', 'Data kept outside Basalt (fix each one, then run host_data_check again):');
          for (const f of a.scan) lines.push(`- ${f.file || 'Project folder'}${f.line ? `, line ${f.line}` : ''}: ${f.problem} Fix: ${f.fix}`);
        } else lines.push('No data is kept outside Basalt.');
      }
      lines.push('', `Safety receipt for the owner (share it only with them):\n${r.receiptUrl}`);
      return text(lines.join('\n'));
    },
  );
  tool('host_api_config','Reads the backend service config (BASALT_API_CONFIG) of an environment.', { app, env }, async (a) => json(await host.apiConfig(ws, a.app, a.env)), { readOnlyHint: true });
  tool(
    'host_update_api_config',
    'Changes backend service config without code (limits, defaultRateLimits, per-route overrides, maintenance, logLevel). Deep-merged (null removes); validated and bounded; applied with a zero-downtime restart.',
    { app, env, config: z.record(z.string(), z.unknown()), replace: z.boolean().optional() },
    async (a) => json((await host.updateApiConfig(ws, a.app, a.env, a.config, a.replace)).config, 'Updated.'),
  );
  tool('host_route_policy', 'Per-route override (rateLimit, timeoutMs, bodyLimitBytes, stricter auth, disabled kill switch). policy=null removes it.', { app, env, route: z.string().describe('e.g. "POST /todos"'), policy: z.record(z.string(), z.unknown()).nullable() }, async (a) =>
    json((await host.routePolicy(ws, a.app, a.env, a.route, a.policy)).config.routes ?? {}, 'Route policy updated.'),
  );
  tool(
    'host_protection',
    'Edge protection for an environment: perIpPerMinute (10–10000), maxConcurrency to the backend (1–512), underAttack (proof-of-work browser challenge before serving), maxBodyBytes. Takes effect within a second.',
    { app, env, perIpPerMinute: z.number().int().optional(), maxConcurrency: z.number().int().optional(), underAttack: z.boolean().optional(), maxBodyBytes: z.number().int().optional() },
    async ({ app: ap, env: e, ...patch }) => json(await host.setProtection(ws, ap, e, patch), 'Protection updated.'),
  );
  tool(
    'host_csp',
    'Allows external origins in the Content-Security-Policy of the frontend (e.g. connectSrc ["https://api.stripe.com"], scriptSrc ["https://js.stripe.com"], frameSrc ["https://js.stripe.com"]). https origins only; replaces each list given.',
    { app, env, connectSrc: z.array(z.string()).optional(), scriptSrc: z.array(z.string()).optional(), imgSrc: z.array(z.string()).optional(), styleSrc: z.array(z.string()).optional(), fontSrc: z.array(z.string()).optional(), frameSrc: z.array(z.string()).optional() },
    async ({ app: ap, env: e, ...patch }) => json(await host.setCsp(ws, ap, e, patch), 'CSP updated.'),
  );

  // ---------------------------------------------------------------- testing
  tool('host_run_tests', 'Re-runs smoke + e2e tests against the current release of a test environment.', { app, env: testEnv }, async (a) => {
    const { app: ap, env: e } = await host.env(ws, a.app, a.env);
    if (e.kind === 'production') throw new UserError('Tests do not run against production.');
    const rel = await host.runtime.liveRelease(e);
    if (!rel) throw new UserError('Nothing is deployed there yet.');
    const dep = await host.deployment(ws, rel.deployment_id);
    const smoke = await host.testing.smoke(ap, e, dep);
    const e2e = await host.testing.e2e(ap, e, dep, host.pipeline.workDir(dep.id));
    return json({ smoke: { status: smoke.status, ...smoke.summary }, e2e: { status: e2e.status, ...e2e.summary } });
  });
  tool('host_test_user', 'Creates a verified test account in a test environment and returns its email and password (for browser_* sign-in).', { app, env: testEnv }, async (a) => {
    const { app: ap, env: e } = await host.env(ws, a.app, a.env);
    return json(await host.testing.createTestUser(ap, e));
  });
  tool('host_test_emails', 'Emails the app sent in a test environment (e.g. sign-up verification codes, password reset codes), newest first. On a one-laptop demo with no email provider, production too.', { app, env }, async (a) => {
    const { env: e } = await host.env(ws, a.app, a.env);
    if (!emailsReadable(e.kind, { localDemo: ctx.cfg.PUBLIC_SCHEME === 'http', resendKey: ctx.cfg.RESEND_API_KEY })) throw new UserError('Production email is private.');
    return json(await host.testing.emails(e.id));
  }, { readOnlyHint: true });
  tool('host_share_link', 'A time-limited link that lets a human open a private preview/staging environment in their browser.', { app, env: testEnv, ttlMinutes: z.number().int().min(5).max(7 * 24 * 60).optional() }, async (a) => {
    const { env: e } = await host.env(ws, a.app, a.env);
    return text(host.testing.shareLink(e, a.ttlMinutes ?? 24 * 60));
  });

  // ---------------------------------------------------------------- browser (Playwright)
  tool(
    'browser_open',
    'Opens a real Chromium session on a preview/staging environment and returns the page snapshot (accessibility tree). Use host_test_user to get credentials for signing in. viewport "phone" opens a 390x844 touch screen (most customers), colorScheme "dark" opens in dark mode: check both before telling the human it looks right.',
    {
      app,
      env: testEnv,
      path: z.string().optional(),
      viewport: z.enum(['desktop', 'phone']).optional().describe('"phone" (390x844, touch) or "desktop" (1280x800, the default).'),
      colorScheme: z.enum(['light', 'dark']).optional(),
    },
    async (a) => {
    const { env: e } = await host.env(ws, a.app, a.env);
    if (e.kind === 'production') throw new UserError('Browser sessions are for preview and staging only.');
    const r = await browser('/sessions', { method: 'POST', body: { host: e.host, accessToken: host.testing.accessToken(e, 3600), path: a.path ?? '/', viewport: a.viewport, colorScheme: a.colorScheme } });
    const p = page(r);
    p.content.unshift({ type: 'text', text: `sessionId: ${r.sessionId}` });
    return p;
  });
  tool('browser_navigate', 'Navigates to a path on the session\'s environment (e.g. "/todos").', { session, path: z.string() }, async (a) => page(await act(a.session, { type: 'navigate', path: a.path })));
  tool('browser_click', 'Clicks an element.', { session, target }, async (a) => page(await act(a.session, { type: 'click', target: a.target })));
  tool('browser_fill', 'Types into an input (replacing its value).', { session, target, value: z.string() }, async (a) => json(await act(a.session, { type: 'fill', target: a.target, value: a.value })));
  tool('browser_press', 'Presses a key (e.g. "Enter"), optionally on an element.', { session, key: z.string(), target: target.optional() }, async (a) => page(await act(a.session, { type: 'press', key: a.key, target: a.target })));
  tool('browser_select', 'Selects option(s) in a <select>.', { session, target, values: z.array(z.string()) }, async (a) => json(await act(a.session, { type: 'select', target: a.target, values: a.values })));
  tool('browser_check', 'Checks or unchecks a checkbox/radio.', { session, target, checked: z.boolean() }, async (a) => json(await act(a.session, { type: 'check', target: a.target, checked: a.checked })));
  tool('browser_hover', 'Hovers an element.', { session, target }, async (a) => json(await act(a.session, { type: 'hover', target: a.target })));
  tool('browser_wait_for', 'Waits until text/element appears (or disappears with gone=true) or the URL contains a string.', { session, text: z.string().optional(), target: target.optional(), urlIncludes: z.string().optional(), gone: z.boolean().optional(), timeoutMs: z.number().int().max(30_000).optional() }, async ({ session: s, ...rest }) => page(await act(s, { type: 'wait_for', ...rest })));
  tool('browser_snapshot', 'Current URL, title and accessibility snapshot of the page.', { session }, async (a) => page(await act(a.session, { type: 'snapshot' })), { readOnlyHint: true });
  tool('browser_screenshot', 'PNG screenshot of the page (or one element) so you can see the visual result.', { session, fullPage: z.boolean().optional(), target: target.optional() }, async (a) => {
    const r = await act(a.session, { type: 'screenshot', fullPage: a.fullPage, target: a.target });
    return { content: [{ type: 'text', text: `URL: ${r.url}` }, { type: 'image', data: String(r.pngBase64), mimeType: 'image/png' }] };
  }, { readOnlyHint: true });
  tool('browser_console', 'Console messages and uncaught page errors (latest 100).', { session }, async (a) => json(await act(a.session, { type: 'console' })), { readOnlyHint: true });
  tool('browser_network', 'Failed requests and HTTP 4xx/5xx responses seen by the page (latest 100).', { session }, async (a) => json(await act(a.session, { type: 'network' })), { readOnlyHint: true });
  tool('browser_evaluate', 'Evaluates a JavaScript expression in the page and returns its JSON value (e.g. "document.title", "localStorage.length").', { session, expression: z.string().max(5000) }, async (a) => json(await act(a.session, { type: 'evaluate', expression: a.expression })));
  tool('browser_close', 'Closes a browser session.', { session }, async (a) => json(await browser(`/sessions/${a.session}`, { method: 'DELETE' })));
  tool('browser_sessions', 'Your open browser sessions.', {}, async () => json(await browser('/sessions')), { readOnlyHint: true });

  // ---------------------------------------------------------------- cleanup
  tool('host_delete_env', 'Deletes a preview or staging environment and its data. Irreversible.', { app, env: testEnv, confirm: z.literal(true) }, async (a) => {
    const { app: ap, env: e } = await host.env(ws, a.app, a.env);
    if (e.kind === 'production') throw new UserError('Use host_delete_app to remove production.');
    await host.destroyEnv(ap, e);
    return text(`Deleted ${a.env}.`);
  }, { destructiveHint: true });
  tool('host_delete_app', 'Asks the owner to delete an app with ALL environments and data, including production. Nothing is deleted until the owner taps Confirm in their dashboard (deleting can\'t be undone). Only when the human explicitly asks.', { app, confirm: z.literal(true).optional() }, async (a) => {
    await host.requestAppDeletion(ws, a.app);
    return text(`Nothing is deleted yet. Deleting ${a.app} removes every version and its data and can't be undone, so the owner confirms it themselves. Give them this link to their dashboard and ask them to tap "Confirm" on "Delete ${a.app}?" (or "Cancel" to keep it). The request waits ${DELETION_HOURS} hours; the link works for 24 hours, don't share it publicly:\n${dashboardLink(ctx.cfg, ws)}`);
  });

  // Stateless guidance and code review from the auth and API toolkits.
  registerAuthTools(server, ctx.authFor(ws), { include: ['auth_integration_guide', 'auth_security_rules', 'auth_review_code'] });
  registerApiTools(server, { platform: undefined as never, auth: ctx.authFor(ws) }, { include: ['api_integration_guide', 'api_security_rules', 'api_review_code'] });
  return server;
}
