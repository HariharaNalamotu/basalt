import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ControlPlaneError, type ControlPlane, type Project } from './control-plane.js';
import { FRAMEWORKS, integrationGuide, RULES } from './guides.js';
import { reviewCode } from './review.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const json = (v: unknown, note?: string): ToolResult => text(`${note ? `${note}\n\n` : ''}${JSON.stringify(v, null, 2)}`);

async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ControlPlaneError) {
      const details = err.details ? `\nDetails: ${JSON.stringify(err.details)}` : '';
      return { isError: true, content: [{ type: 'text', text: `Error (${err.code}): ${err.message}${details}` }] };
    }
    throw err;
  }
}

const projectId = z.string().regex(/^prj_[A-Za-z0-9]+$/).describe('Project id (prj_...).');
const userId = z.string().uuid().describe("User id (UUID) — the `id` from the SDK's user object.");
const origins = z
  .array(z.string())
  .max(50)
  .describe('Exact origins that serve the frontend, e.g. ["https://myapp.com", "http://localhost:5173"]. https only (http allowed for localhost). No wildcards or paths.');
const settings = z
  .object({
    requireEmailVerification: z.boolean().describe('Default true. Leave on unless the user explicitly asks.'),
    accessTokenTtlSeconds: z.number().int().describe('60–3600, default 600.'),
    sessionIdleTimeoutSeconds: z.number().int().describe('300–2592000 (30d), default 7 days.'),
    sessionMaxLifetimeSeconds: z.number().int().describe('3600–7776000 (90d), default 30 days.'),
    passwordMinLength: z.number().int().describe('10–64, default 10.'),
    checkBreachedPasswords: z.boolean().describe('Default true.'),
    allowTotp: z.boolean().describe('Allow authenticator-app 2FA. Default true.'),
    allowBearerTokens: z.boolean().describe('Allow native/mobile token mode. Default true.'),
    appName: z.string().describe('Name shown in emails and authenticator apps.'),
  })
  .partial()
  .describe('Optional. Every value is bounded server-side; omit to keep secure defaults.');

function envBlock(cp: ControlPlane, project: Project, secret: { envVar: string } | { value: string }) {
  const secretLine =
    'envVar' in secret
      ? `${secret.envVar}  (already stored in the app's secrets by the platform — you never need to see it)`
      : `BASALT_AUTH_SECRET_KEY=${secret.value}`;
  return [
    'BASALT_PROJECT_ID=' + project.id,
    'BASALT_AUTH_URL=' + cp.authUrl,
    secretLine,
  ].join('\n');
}

export interface RegisterOptions {
  /** Prefix for tool names (default "auth_"). */
  prefix?: string;
}

/**
 * Registers the Basalt Auth tools on an MCP server. The platform's unified MCP server calls this
 * with a ControlPlane scoped to the authenticated workspace.
 */
export function registerAuthTools(server: McpServer, cp: ControlPlane, opts: RegisterOptions = {}) {
  const name = (n: string) => `${opts.prefix ?? 'auth_'}${n}`;

  server.registerTool(
    name('integration_guide'),
    {
      title: 'Basalt Auth integration guide',
      description:
        'START HERE before writing any sign-up, sign-in, session, password or user-permission code. Returns the exact, tested code to integrate Basalt Auth for a framework, plus the security rules the app must follow. Copy the patterns; do not write your own auth logic.',
      inputSchema: { framework: z.enum(FRAMEWORKS).describe('react = browser SPA (Vite/CRA); nextjs = App Router; express/hono = backend API; native = mobile/CLI.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ framework }) => text(integrationGuide(framework)),
  );

  server.registerTool(
    name('security_rules'),
    {
      title: 'Basalt Auth security rules',
      description: 'The short list of rules every app using Basalt Auth must follow. Re-read before finishing any auth-related change.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => text(RULES),
  );

  server.registerTool(
    name('review_code'),
    {
      title: 'Review code for auth mistakes',
      description:
        'Scans source code for common auth security mistakes (tokens in localStorage, unverified JWT decoding, hardcoded/exposed secret keys, own password hashing, client-supplied user ids, permissive CORS, etc.). Run it on every file you created or changed that touches users, sessions, or permissions, and fix all critical/high findings.',
      inputSchema: {
        files: z
          .array(z.object({ path: z.string().describe('File path (used to tell browser vs server code).'), content: z.string().max(500_000) }))
          .min(1)
          .max(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ files }) => {
      const results = files.map((f) => ({ path: f.path, findings: reviewCode(f.content, f.path) })).filter((r) => r.findings.length);
      if (!results.length) return text('No auth issues found in the provided files.');
      const total = results.reduce((n, r) => n + r.findings.length, 0);
      const blocking = results.some((r) => r.findings.some((f) => f.severity === 'critical' || f.severity === 'high'));
      return json(results, `${total} finding(s).${blocking ? ' Fix every critical/high finding before shipping.' : ''}`);
    },
  );

  server.registerTool(
    name('create_project'),
    {
      title: 'Create auth project',
      description:
        "Creates a Basalt Auth project (an isolated user pool) for an app and returns the environment variables the app's backend needs. Create ONE project per app; reuse it across dev and prod (add both origins). Check auth_list_projects first so you don't create duplicates.",
      inputSchema: { name: z.string().min(1).max(100).describe('App name; shown to users in emails.'), allowedOrigins: origins.optional(), settings: settings.optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) =>
      run(async () => {
        const { project, secretKey } = await cp.createProject(input);
        if (cp.storeProjectSecret) {
          const stored = await cp.storeProjectSecret(project.id, secretKey);
          return text(
            `Created auth project ${project.id}.\n\nBackend environment (managed by the platform):\n${envBlock(cp, project, stored)}\n\nNext: call ${name('integration_guide')} for your framework.`,
          );
        }
        return text(
          [
            `Created auth project ${project.id}.`,
            '',
            "Put these in the backend's environment / secret store (NOT in frontend code, NOT committed to git, NOT logged):",
            envBlock(cp, project, { value: secretKey }),
            '',
            'The secret key is shown only this once. If it is ever exposed, call ' + name('rotate_secret_key') + '.',
            `Next: call ${name('integration_guide')} for your framework.`,
          ].join('\n'),
        );
      }),
  );

  server.registerTool(
    name('list_projects'),
    {
      title: 'List auth projects',
      description: 'Lists the auth projects in this workspace with their origins and settings.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => run(async () => json((await cp.listProjects()).projects)),
  );

  server.registerTool(
    name('get_project'),
    {
      title: 'Get auth project',
      description: 'Shows a project’s allowed origins, settings, issuer and JWKS URL.',
      inputSchema: { projectId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId }) => run(async () => json((await cp.getProject(projectId)).project)),
  );

  server.registerTool(
    name('update_project'),
    {
      title: 'Update auth project',
      description:
        "Updates a project's allowed origins and/or settings. `allowedOrigins` REPLACES the list — include existing origins you want to keep. Add every domain the frontend is served from (production, previews, localhost for dev).",
      inputSchema: { projectId, name: z.string().min(1).max(100).optional(), allowedOrigins: origins.optional(), settings: settings.optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId, ...patch }) => run(async () => json((await cp.updateProject(projectId, patch)).project, 'Updated.')),
  );

  server.registerTool(
    name('rotate_secret_key'),
    {
      title: 'Rotate project secret key',
      description:
        'Issues a new project secret key. The old key stops working IMMEDIATELY, so update BASALT_AUTH_SECRET_KEY right away. Use when the key may have leaked (committed, logged, sent to the browser).',
      inputSchema: { projectId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ projectId }) =>
      run(async () => {
        const { secretKey } = await cp.rotateSecretKey(projectId);
        if (cp.storeProjectSecret) {
          const { envVar } = await cp.storeProjectSecret(projectId, secretKey);
          return text(`Rotated. The new key was written to ${envVar} by the platform; redeploy the backend to pick it up.`);
        }
        return text(`Rotated. Set this in the backend environment now (old key is already invalid):\nBASALT_AUTH_SECRET_KEY=${secretKey}`);
      }),
  );

  server.registerTool(
    name('rotate_signing_key'),
    {
      title: 'Rotate token signing key',
      description: 'Starts signing tokens with a new key. Existing sessions keep working (the old key stays published until its tokens expire). No app changes needed.',
      inputSchema: { projectId },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ projectId }) => run(async () => json(await cp.rotateSigningKey(projectId), 'Signing key rotated.')),
  );

  server.registerTool(
    name('enable_data_protection'),
    {
      title: 'Enable database-enforced data ownership',
      description:
        "Installs Basalt Auth's verifier into the app's Postgres database so the DATABASE checks each request's session and only returns rows the user owns (Row-Level Security). Do this for every app that stores per-user data in Postgres, then follow auth_integration_guide with framework 'database'. Safe to run again.",
      inputSchema: { projectId },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId }) =>
      run(async () => {
        const next = `Next: in a migration, give each per-user table an \`owner_id uuid NOT NULL DEFAULT basalt_auth.uid()\` column and run \`SELECT basalt_auth.protect('<table>')\`; query with \`auth.withUserDb(pool, req, fn)\`. Full instructions: ${name('integration_guide')} with framework "database".`;
        if (cp.installDataProtection) {
          const r = await cp.installDataProtection(projectId);
          return text(`Installed data protection into ${r.database}. The app connects as "${r.appRole}" (restricted: cannot bypass row-level security or read the key).\n\n${next}`);
        }
        const sql = await cp.getDataProtectionSql(projectId);
        return text(
          [
            'Run the SQL below ONCE against the app database as its admin/owner role, e.g. save it to a temporary file OUTSIDE the repository and run:',
            '  psql "$DATABASE_ADMIN_URL" -v ON_ERROR_STOP=1 -f /tmp/basalt-auth.sql && rm /tmp/basalt-auth.sql',
            'It contains the project\'s data-grant key. Do NOT commit it, put it in a migration file, or print it in logs.',
            'The app itself must connect with a different, restricted role (not superuser, no BYPASSRLS, not the table owner).',
            '',
            next,
            '',
            '```sql',
            sql.trim(),
            '```',
          ].join('\n'),
        );
      }),
  );

  server.registerTool(
    name('list_users'),
    {
      title: 'List users',
      description: 'Lists users of a project (paginated), or finds one by email.',
      inputSchema: {
        projectId,
        email: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional().describe('nextCursor from the previous page.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId, ...q }) => run(async () => json(await cp.listUsers(projectId, q))),
  );

  server.registerTool(
    name('get_user'),
    {
      title: 'Get user',
      description: 'Shows one user (email, verification, MFA, metadata, disabled).',
      inputSchema: { projectId, userId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId, userId }) => run(async () => json((await cp.getUser(projectId, userId)).user)),
  );

  server.registerTool(
    name('update_user'),
    {
      title: 'Update user',
      description:
        "Sets a user's metadata (REPLACES the whole object; max 16 KB — use it for roles/plan) and/or disables/enables the account. Disabling signs the user out everywhere.",
      inputSchema: {
        projectId,
        userId,
        metadata: z.record(z.string(), z.unknown()).optional(),
        disabled: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId, userId, ...patch }) => run(async () => json((await cp.updateUser(projectId, userId, patch)).user, 'Updated.')),
  );

  server.registerTool(
    name('revoke_user_sessions'),
    {
      title: 'Sign a user out everywhere',
      description: 'Revokes all of a user’s sessions (e.g. suspected compromise).',
      inputSchema: { projectId, userId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId, userId }) => run(async () => json(await cp.revokeSessions(projectId, userId))),
  );

  server.registerTool(
    name('delete_user'),
    {
      title: 'Delete user',
      description: 'Permanently deletes a user and their sessions. Irreversible. Only do this when the human explicitly asks.',
      inputSchema: { projectId, userId, confirm: z.literal(true).describe('Must be true; confirms the human asked for deletion.') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId, userId }) =>
      run(async () => {
        await cp.deleteUser(projectId, userId);
        return text(`Deleted user ${userId}.`);
      }),
  );

  server.registerTool(
    name('list_events'),
    {
      title: 'Auth audit log',
      description:
        'Recent security events (sign-ups, sign-ins, failures, password resets, MFA changes, refresh-token theft detection). Use to debug sign-in problems or investigate incidents.',
      inputSchema: {
        projectId,
        userId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        before: z.number().int().optional().describe('Return events with id lower than this (pagination).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId, ...q }) => run(async () => json((await cp.listEvents(projectId, q)).events)),
  );
}
