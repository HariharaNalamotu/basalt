import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ControlPlaneError, reviewCode } from '@basalt/auth-mcp';
import { apiGuide, API_RULES, TOPICS } from './guides.js';
import { APP_NAME_RE, mergeConfig, readConfig, rotateEdgeSecret, setRoutePolicy, setupApp, status, writeConfig, type Deps } from './provision.js';
import { reviewApiCode } from './review.js';
import { scaffold } from './scaffold.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const json = (v: unknown, note?: string): ToolResult => text(`${note ? `${note}\n\n` : ''}${JSON.stringify(v, null, 2)}`);

async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    // Include validation details so the agent can fix the input instead of guessing.
    const details = err instanceof ControlPlaneError && err.details ? `\n${JSON.stringify(err.details, null, 2)}` : '';
    return { isError: true, content: [{ type: 'text', text: `Error: ${(err as Error).message}${details}` }] };
  }
}

const app = z.string().regex(APP_NAME_RE).describe('App name: lowercase letters, digits, dashes (e.g. "todo-app"). Use the same name for every call.');
const rule = z.object({ limit: z.number().int(), windowSeconds: z.number().int() });
const routeKey = z.string().describe('Route as written in code, without /api: e.g. "POST /todos" or "GET /todos/:id".');

/** Registers the Basalt API tools. `deps` is scoped to the authenticated workspace by the platform. */
export function registerApiTools(mcp: McpServer, deps: Deps, opts: { include?: string[] } = {}) {
  const server = onlyTools(mcp, opts.include);
  server.registerTool(
    'api_setup',
    {
      title: 'Provision the API backend',
      description:
        'START HERE for any app that needs a backend. Provisions everything in one idempotent call: auth project, edge secret, Postgres (admin + restricted runtime roles), database-enforced data ownership, Redis, and all environment variables (secrets are stored, never shown). Safe to re-run: it repairs what is missing and can add new origins. Then call api_scaffold or api_integration_guide.',
      inputSchema: {
        app,
        name: z.string().min(1).max(100).optional().describe('Display name shown to users (emails, authenticator apps).'),
        origins: z
          .array(z.string())
          .max(50)
          .optional()
          .describe('Every origin the app is served from, e.g. ["http://localhost:8080", "https://myapp.com"]. https only, http only for localhost.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      run(async () => {
        const r = await setupApp(deps, input);
        return text(
          [
            `Backend for "${input.app}" is provisioned (auth project ${r.projectId}).`,
            '',
            ...r.steps.map((s) => `- ${s}`),
            '',
            'Environment (managed by the platform; never hardcode or edit these):',
            ...Object.entries(r.env).map(([k, v]) => `  ${k}=${v}`),
            r.note ? `\n${r.note}` : '',
            '',
            'Next: api_scaffold (starter files) or api_integration_guide topic "routes". Then api_status to verify.',
          ].join('\n'),
        );
      }),
  );

  server.registerTool(
    'api_status',
    {
      title: 'Backend status and security checks',
      description:
        'Shows the app backend\'s environment (secrets masked), health and security checks with concrete fixes (auth origins, database protection, unprotected tables, runtime role, config validity, maintenance mode), and every running route with its effective auth, rate limit, timeout and body limit. Run after every change.',
      inputSchema: { app },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ app: name }) =>
      run(async () => {
        const r = await status(deps, name);
        const failing = r.checks.filter((c) => !c.ok);
        const lines = [
          `Platform: ${r.platform}`,
          failing.length ? `${failing.length} check(s) need attention.` : 'All checks pass.',
          '',
          ...r.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.check}${c.fix ? `\n    fix: ${c.fix}` : ''}`),
          '',
          'Environment:',
          ...Object.entries(r.env).map(([k, v]) => `  ${k}=${v}`),
        ];
        if (r.routes) {
          lines.push('', 'Routes (effective policy):');
          for (const rt of r.routes) {
            lines.push(`  ${rt.method} ${rt.path}  auth=${JSON.stringify(rt.auth)} rateLimit=${JSON.stringify(rt.rateLimit)} timeoutMs=${rt.timeoutMs}${rt.disabled ? ' DISABLED' : ''}`);
          }
        }
        return text(lines.join('\n'));
      }),
  );

  server.registerTool(
    'api_get_config',
    {
      title: 'Read API service config',
      description: 'Returns the current BASALT_API_CONFIG (operational settings: limits, origins, per-route overrides, maintenance).',
      inputSchema: { app },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ app: name }) => run(async () => json(await readConfig(deps.platform, name))),
  );

  server.registerTool(
    'api_update_config',
    {
      title: 'Change API service config',
      description:
        'Changes operational settings without code: allowedOrigins (other origins calling this API cross-site), limits {maxInFlight, defaultTimeoutMs, defaultBodyLimitBytes, perIp}, defaultRateLimits {user, public}, routes {"METHOD /path": override}, maintenance, revocationSync, logLevel. Deep-merges by default (null removes a key); replace=true overwrites. The full result is validated and bounded; on any error nothing is written. Route auth can only be made stricter here.',
      inputSchema: {
        app,
        config: z.record(z.string(), z.unknown()).describe('Partial config to merge (see api_integration_guide topic "config" for the schema).'),
        replace: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ app: name, config, replace }) =>
      run(async () => {
        const current = replace ? {} : ((await readConfig(deps.platform, name)) as Record<string, unknown>);
        const r = await writeConfig(deps.platform, name, mergeConfig(current, config));
        return json(r.config, `Config updated.${r.note ? ` ${r.note}` : ''}`);
      }),
  );

  server.registerTool(
    'api_set_route_policy',
    {
      title: 'Set a per-route policy',
      description:
        'Overrides one route\'s rateLimit, timeoutMs (100–30000), bodyLimitBytes (≤10 MB), auth (stricter only: "required" or {mfa, emailVerified, maxAgeSeconds, strict}) or disabled (kill switch → 503). Pass policy=null to remove the override.',
      inputSchema: {
        app,
        route: routeKey,
        policy: z
          .object({
            rateLimit: rule.optional(),
            timeoutMs: z.number().int().optional(),
            bodyLimitBytes: z.number().int().optional(),
            auth: z.union([z.literal('required'), z.object({ mfa: z.boolean().optional(), emailVerified: z.boolean().optional(), maxAgeSeconds: z.number().int().optional(), strict: z.boolean().optional() })]).optional(),
            disabled: z.boolean().optional(),
          })
          .nullable(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ app: name, route, policy }) =>
      run(async () => {
        const r = await setRoutePolicy(deps.platform, name, route, policy as never);
        return json(r.config.routes ?? {}, `Route policy ${policy ? 'set' : 'removed'} for ${route}.${r.note ? ` ${r.note}` : ''}`);
      }),
  );

  server.registerTool(
    'api_set_maintenance',
    {
      title: 'Maintenance mode',
      description: 'Turns maintenance mode on/off. When on, every route answers 503 with Retry-After and the message; health checks keep passing.',
      inputSchema: { app, enabled: z.boolean(), message: z.string().max(200).optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ app: name, enabled, message }) =>
      run(async () => {
        const current = (await readConfig(deps.platform, name)) as Record<string, unknown>;
        const r = await writeConfig(deps.platform, name, { ...current, maintenance: enabled ? { enabled, ...(message ? { message } : {}) } : undefined });
        return text(`Maintenance mode ${enabled ? 'ON' : 'OFF'}.${r.note ? ` ${r.note}` : ''}`);
      }),
  );

  server.registerTool(
    'api_rotate_edge_secret',
    {
      title: 'Rotate the edge secret',
      description: 'Generates a new edge↔backend secret. Use if it may have leaked. The backend must be restarted/redeployed with the new value (the hosted platform does this automatically).',
      inputSchema: { app },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ app: name }) =>
      run(async () => {
        const r = await rotateEdgeSecret(deps, name);
        return text(`Edge secret rotated.${r.note ? ` ${r.note}` : ''}`);
      }),
  );

  server.registerTool(
    'api_scaffold',
    {
      title: 'Starter files for the backend',
      description: 'Returns complete, working starter files (server entry, a CRUD route module, a protected-table migration, the frontend client, package.json scripts) wired to what api_setup provisioned. Write them as-is, then add routes in the same style.',
      inputSchema: { app },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ app: name }) =>
      run(async () => {
        const files = scaffold(name);
        return text(
          [
            'Write these files (paths relative to the project root):',
            ...Object.entries(files).map(([p, c]) => `\n### ${p}\n\`\`\`${p.endsWith('.sql') ? 'sql' : p.endsWith('.ts') ? 'ts' : 'json'}\n${c.trimEnd()}\n\`\`\``),
            '',
            'Then: npm install, npm run db:migrate, npm run dev:api, npm run dev:edge, open http://localhost:8080, and call api_status.',
          ].join('\n'),
        );
      }),
  );

  server.registerTool(
    'api_integration_guide',
    {
      title: 'Basalt API guide',
      description: `How to build the backend correctly with @basalt/api. Read "setup" first, then "routes" before writing endpoints. Topics: ${TOPICS.join(', ')}.`,
      inputSchema: { topic: z.enum(TOPICS) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ topic }) => text(apiGuide(topic)),
  );

  server.registerTool(
    'api_security_rules',
    {
      title: 'Basalt API security rules',
      description: 'The rules every backend endpoint must follow. Re-read before finishing backend work.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => text(API_RULES),
  );

  server.registerTool(
    'api_review_code',
    {
      title: 'Review backend code',
      description:
        'Scans backend (and frontend) files for API and auth security mistakes: SQL string building, raw DB clients, competing HTTP servers, catch-all response schemas, public write routes, disabled edge checks, SSRF, error-detail leaks, disabled TLS, client-supplied user ids, tokens in storage, and more. Run on every file you create or change; fix all critical/high findings.',
      inputSchema: { files: z.array(z.object({ path: z.string(), content: z.string().max(500_000) })).min(1).max(50) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ files }) => {
      const results = files.map((f) => ({ path: f.path, findings: reviewApiCode(f.content, f.path) })).filter((r) => r.findings.length);
      if (!results.length) return text('No issues found in the provided files.');
      const total = results.reduce((n, r) => n + r.findings.length, 0);
      const blocking = results.some((r) => r.findings.some((f) => f.severity === 'critical' || f.severity === 'high'));
      return json(results, `${total} finding(s).${blocking ? ' Fix every critical/high finding before shipping.' : ''}`);
    },
  );
}

export { reviewCode };

/** Wraps a server so only the named tools get registered. */
export function onlyTools(server: McpServer, include?: string[]): McpServer {
  if (!include) return server;
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'registerTool') {
        return (name: string, ...rest: unknown[]) =>
          include.includes(name) ? (target.registerTool as (...a: unknown[]) => unknown)(name, ...rest) : undefined;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
