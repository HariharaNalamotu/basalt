/**
 * What coding agents are told. Every snippet is complete and tested against the reviewer, so
 * copying it is always the safe choice.
 */
export const TOPICS = ['setup', 'routes', 'database', 'errors', 'public-routes', 'outbound-http', 'frontend', 'config'] as const;
export type Topic = (typeof TOPICS)[number];

export const API_RULES = `## Non-negotiable rules for Basalt API backends

1. **Build every endpoint with \`createApi()\` from \`@basalt/api\`.** No express/fastify/koa/http.createServer, no hand-rolled routers. The framework is what enforces auth, validation, limits and status codes.
2. **Routes require a signed-in user by default. Leave it that way.** Only add \`auth: 'public'\` for data that is genuinely public (marketing content, health, sign-up adjacent forms). Never make a route public to "fix" a 401: the client should sign in instead.
3. **Every route declares schemas**: \`params\` (validate ids, e.g. \`z.uuid()\`), \`query\`, \`body\` and \`response\`. The response schema is the allow-list of fields sent to clients; never use \`z.any()\`/\`z.unknown()\` there.
4. **Talk to the database only through \`ctx.sql\`** (tagged template). Never import \`pg\`, never build SQL strings, never interpolate into SQL text. Per-user tables are protected with \`basalt_auth.protect()\` in migrations so Postgres itself enforces ownership.
5. **Never take a user id from the request** (\`body.userId\`, \`query.ownerId\`, ...). The verified user is \`ctx.user\`; \`owner_id\` defaults to it in the database.
6. **Signal outcomes with the framework**: return data (200/201/202 via \`status\`/\`ctx.reply\`), \`response: null\` for 204, and \`throw errors.notFound()\` / \`errors.conflict()\` / \`errors.forbidden()\` / \`errors.badRequest()\` for failures. Never build error responses by hand or return \`err.message\`/stacks.
7. **Fetch user-influenced URLs only with \`ctx.fetch\`** (blocks internal network / cloud metadata).
8. **Sensitive actions** (payments, deleting data, changing email/roles) use \`auth: { maxAgeSeconds: 300 }\` (step-up) and \`idempotency: 'required'\` for money-moving POSTs.
9. **Never hardcode secrets or edit \`.basalt/*.env\` by hand.** All configuration and secrets are managed with the \`api_*\` MCP tools; operational tuning goes through \`api_update_config\` / \`api_set_route_policy\`, not code.
10. **Run \`api_review_code\` on every backend file you write, and \`api_status\` after changes.** Fix every critical/high finding and every failing check.
`;

const SETUP = `# Basalt API — setup (plug and play)

### 1. Provision (one MCP call, safe to repeat)
Call \`api_setup\` with the app name and the origins the app is served from, e.g.
\`{ "app": "todo-app", "origins": ["http://localhost:8080", "https://todo-app.basalt.app"] }\`.
It creates the auth project, the edge secret, a Postgres database with an admin role and a restricted runtime role, database-enforced ownership, Redis, and writes every variable to the platform env store (locally: \`.basalt/todo-app.env\`, git-ignored). You never see or handle the secrets.

### 2. Install
\`\`\`bash
npm install @basalt/api @basalt/auth
\`\`\`

### 3. Get starter files
Call \`api_scaffold\` and write the files it returns (server entry, a complete CRUD route module, a migration, the frontend client). Or write them yourself following the **routes** topic.

### 4. Server entry — this is all the wiring there is
\`\`\`ts
import { createApi } from '@basalt/api';
import { serve } from '@basalt/api/serve';
import { registerTodoRoutes } from './routes/todos.ts';

const api = createApi(); // reads everything api_setup provisioned
registerTodoRoutes(api);
serve(api);
\`\`\`

### 5. Run locally
\`\`\`bash
node --env-file=.basalt/todo-app.env node_modules/@basalt/api/dist/migrate-cli.js      # apply db/migrations/*.sql
node --env-file=.basalt/todo-app.env --watch server/index.ts                          # backend on :3000
node --env-file=.basalt/todo-app.env node_modules/@basalt/api/dist/dev-edge-cli.js --frontend http://localhost:5173
\`\`\`
Open the app at **http://localhost:8080** (the dev edge), not the backend or frontend ports: the edge serves auth, API and frontend on one origin exactly like production, and the backend rejects requests that didn't come through it.

### 6. Verify
Call \`api_status\` — it checks env, auth origins, database protection, the runtime role, and lists every running route with its effective auth/limits.
`;

const ROUTES = `# Basalt API — writing routes

\`\`\`ts
import { errors, z, type Api } from '@basalt/api';

const Todo = z.object({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
  createdAt: z.date(),
});
type TodoRow = { id: string; title: string; done: boolean; created_at: Date };
const toTodo = (r: TodoRow) => ({ id: r.id, title: r.title, done: r.done, createdAt: r.created_at });

export function registerTodoRoutes(api: Api) {
  // auth omitted = signed-in user required (401 otherwise)
  api.get('/todos', {
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
    response: z.array(Todo),
  }, async ({ sql, query }) => {
    // No WHERE owner_id needed: the database only returns this user's rows.
    const rows = await sql<TodoRow>\`SELECT * FROM todos ORDER BY created_at DESC LIMIT \${query.limit}\`;
    return rows.map(toTodo);
  });

  api.post('/todos', {
    body: z.object({ title: z.string().trim().min(1).max(200) }),
    response: Todo,
    status: 201,
  }, async ({ sql, body }) => {
    // owner_id is filled in by the database from the verified session.
    return toTodo(await sql.one<TodoRow>\`INSERT INTO todos (title) VALUES (\${body.title}) RETURNING *\`);
  });

  api.patch('/todos/:id', {
    params: z.object({ id: z.uuid() }),
    body: z.object({ title: z.string().trim().min(1).max(200).optional(), done: z.boolean().optional() }),
    response: Todo,
  }, async ({ sql, params, body }) => {
    // one() -> 404 when the row doesn't exist OR belongs to someone else (existence isn't revealed).
    return toTodo(await sql.one<TodoRow>\`
      UPDATE todos SET title = COALESCE(\${body.title ?? null}, title), done = COALESCE(\${body.done ?? null}, done)
      WHERE id = \${params.id} RETURNING *\`);
  });

  api.delete('/todos/:id', {
    params: z.object({ id: z.uuid() }),
    response: null, // 204
  }, async ({ sql, params }) => {
    const r = await sql.exec\`DELETE FROM todos WHERE id = \${params.id}\`;
    if (r.rowCount === 0) throw errors.notFound('Todo not found.');
  });
}
\`\`\`

Route options: \`auth\` ('required' default | 'optional' | 'public' | { mfa, emailVerified, maxAgeSeconds, strict }), \`params\`, \`query\`, \`body\` (required for POST/PUT/PATCH; \`null\` = no body), \`response\` (\`null\` = 204), \`status\` (200/201/202), \`authorize\` (extra check, false = 403), \`rateLimit\`, \`idempotency\` ('optional' default on POST/PATCH, 'required' for payments), \`timeoutMs\`, \`cache\` (public GET only), \`bodyLimitBytes\`.

Handler context: \`user\`, \`params\`, \`query\`, \`body\`, \`sql\` (+ \`sql.one\`, \`sql.maybeOne\`, \`sql.exec\`), \`fetch\` (SSRF-safe), \`signal\`, \`log\`, \`request\` (id, ip, header()), \`reply(status, body, { location })\`.

Dynamic SQL (optional filters, sort order): build fragments with the imported \`sql\` tag and nest them:
\`\`\`ts
import { sql as fragment } from '@basalt/api';
const order = query.order === 'asc' ? fragment\`ASC\` : fragment\`DESC\`;
const conditions = [fragment\`true\`];
if (query.done !== undefined) conditions.push(fragment\`done = \${query.done}\`);
const rows = await ctx.sql\`SELECT * FROM todos WHERE \${fragment.join(conditions, fragment\` AND \`)} ORDER BY created_at \${order}\`;
\`\`\`
Choose sort columns with \`z.enum([...])\` + a fixed mapping to fragments; never put user text into SQL.
`;

const DATABASE = `# Basalt API — database

Migrations live in \`db/migrations/NNN_name.sql\` and run with the admin role (\`basalt-migrate\`). The app runs as a restricted role that cannot bypass row-level security.

\`\`\`sql
-- db/migrations/001_todos.sql
CREATE TABLE todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL DEFAULT basalt_auth.uid(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX todos_owner_created_idx ON todos (owner_id, created_at DESC);
SELECT basalt_auth.protect('todos');
\`\`\`

- Every per-user table: \`owner_id uuid NOT NULL DEFAULT basalt_auth.uid()\` + \`SELECT basalt_auth.protect('table')\`. Index \`owner_id\` (first column of composite indexes you filter by).
- Shared data (public posts, teams, admins): see the \`auth_integration_guide\` "database" topic for policy patterns using \`basalt_auth.uid()\`.
- Constraint errors become the right HTTP status automatically: unique -> 409, foreign key -> 409, check/not-null -> 422, bad uuid -> 400.
- \`basalt-migrate\` refuses migrations that disable RLS and warns about unprotected per-user tables; \`api_status\` reports them too.
`;

const ERRORS = `# Basalt API — status codes and errors

| Situation | Do this | Client gets |
|---|---|---|
| Success, returning data | \`return data\` | 200 (or \`status: 201/202\`) |
| Created with a URL | \`return reply(201, data, { location: '/api/todos/' + id })\` | 201 + Location |
| Nothing to return | \`response: null\` | 204 |
| Not found / not yours | \`throw errors.notFound()\` or \`sql.one\` | 404 |
| Invalid business input | \`throw errors.validation([{ path: 'body.date', message: 'Must be in the future' }])\` | 422 |
| Bad query/params | (automatic from schemas) | 400 |
| Duplicate | (automatic from unique constraint) or \`errors.conflict()\` | 409 |
| Not allowed (known resource) | \`throw errors.forbidden()\` | 403 |
| Stale version | \`throw errors.preconditionFailed()\` | 412 |
| Not signed in / session revoked | (automatic) | 401 |
| Too many requests | (automatic) | 429 + Retry-After |
| Dependency down | \`throw errors.unavailable(5)\` | 503 + Retry-After |
| Bug / unexpected | (automatic: logged with requestId, generic message) | 500 |
| Too slow | (automatic: \`timeoutMs\`) | 504 |

Error body is always \`{ "error": { "code", "message", "requestId", "details"? } }\`. \`message\` is safe to show users. Never put internal details in messages.
`;

const PUBLIC = `# Basalt API — public routes

Only for data anyone may see or actions anyone may take (contact form, waitlist, public catalog).

\`\`\`ts
api.get('/products', {
  auth: 'public',
  query: z.object({ category: z.string().max(50).optional() }),
  response: z.array(z.object({ id: z.string(), name: z.string(), priceCents: z.number().int() })),
  cache: { maxAgeSeconds: 60 },
}, async ({ sql, query }) => {
  const rows = await sql<{ id: string; name: string; price_cents: number }>\`
    SELECT id, name, price_cents FROM products WHERE published AND (\${query.category ?? null}::text IS NULL OR category = \${query.category ?? null})\`;
  return rows.map((r) => ({ id: r.id, name: r.name, priceCents: r.price_cents }));
});

api.post('/waitlist', {
  auth: 'public',
  body: z.object({ email: z.email().max(254) }),
  response: null,
  rateLimit: { limit: 5, windowSeconds: 3600 },
}, async ({ sql, body }) => {
  await sql\`INSERT INTO waitlist (email) VALUES (\${body.email}) ON CONFLICT DO NOTHING\`;
});
\`\`\`
Public handlers run without a data grant: protected per-user tables are invisible to them. Public tables need explicit grants/policies. Keep public write routes on tight rate limits.
`;

const OUTBOUND = `# Basalt API — calling other services

\`\`\`ts
api.post('/link-preview', {
  body: z.object({ url: z.url().max(2000) }),
  response: z.object({ title: z.string().nullable() }),
}, async ({ body, fetch }) => {
  const res = await fetch(body.url); // SSRF-safe: blocks localhost, private networks, cloud metadata
  if (!res.ok) return { title: null };
  const html = await res.text();
  return { title: /<title>([^<]{0,200})<\\/title>/i.exec(html)?.[1] ?? null };
});
\`\`\`
\`ctx.fetch\` checks the actual connected address after DNS on every redirect, caps size (5 MB) and time (10 s), and only allows ports 80/443. A blocked URL becomes a 400 for the client. For your own trusted third-party APIs with fixed URLs (e.g. a payment provider) the global \`fetch\` is fine; anything a user can influence must use \`ctx.fetch\`.
`;

const FRONTEND = `# Basalt API — calling it from the frontend

\`\`\`ts
// src/lib/api.ts
import { createAuthClient } from '@basalt/auth/client';
import { createApiClient } from '@basalt/api/client';

export const auth = createAuthClient();
export const api = createApiClient({ auth });
\`\`\`
\`\`\`ts
import { ApiRequestError } from '@basalt/api/client';
import { api } from './lib/api';

type Todo = { id: string; title: string; done: boolean; createdAt: string };

const todos = await api.get<Todo[]>('/todos', { query: { limit: 20 } });
try {
  await api.post<Todo>('/todos', { title });
} catch (err) {
  if (err instanceof ApiRequestError && err.status === 422) showFieldErrors(err.details);
  else if (err instanceof ApiRequestError) showToast(err.message); // safe to display
}
\`\`\`
The client sends the session cookie, refreshes expired sessions, adds an Idempotency-Key to every POST/PATCH and safely retries 502/503/504 and network failures. On \`reauthentication_required\` (403), ask for the password, call \`auth.reauthenticate({ password })\`, and retry.
`;

const CONFIG = `# Basalt API — changing behaviour without code (MCP-managed config)

Operational settings live in \`BASALT_API_CONFIG\`, managed only through MCP tools (validated and bounded; invalid changes are rejected and nothing is written):

| Need | Tool |
|---|---|
| See everything (env, checks, routes and their effective policy) | \`api_status\` |
| Read current config | \`api_get_config\` |
| Change limits, origins, defaults, log level | \`api_update_config\` (deep-merge; \`null\` removes a key; \`replace: true\` overwrites) |
| Per-route rate limit / timeout / body size / stricter auth / kill switch | \`api_set_route_policy\` |
| Take the whole API down for maintenance (503 + Retry-After) | \`api_set_maintenance\` |
| Rotate the edge secret | \`api_rotate_edge_secret\` |
| Add an origin (new domain) | \`api_setup\` again with the extra origin |

Config schema:
\`\`\`json
{
  "allowedOrigins": ["https://admin.example.com"],
  "limits": { "maxInFlight": 512, "defaultTimeoutMs": 10000, "defaultBodyLimitBytes": 102400, "perIp": { "limit": 600, "windowSeconds": 60 } },
  "defaultRateLimits": { "user": { "limit": 120, "windowSeconds": 60 }, "public": { "limit": 30, "windowSeconds": 60 } },
  "routes": { "POST /todos": { "rateLimit": { "limit": 20, "windowSeconds": 60 }, "timeoutMs": 5000, "bodyLimitBytes": 2048, "auth": { "mfa": true }, "disabled": false } },
  "maintenance": { "enabled": false, "message": "Back soon" },
  "revocationSync": true,
  "logLevel": "info"
}
\`\`\`
Route keys are "METHOD /path" exactly as written in code (without /api). Config can make auth stricter but never looser; changing who may call a route is a code change. \`allowedOrigins\` is only for OTHER origins that call this API cross-site; the app's own origin needs nothing. After a change, restart the backend locally (the hosted platform rolls it out automatically).
`;

const GUIDES: Record<Topic, string> = {
  setup: SETUP,
  routes: ROUTES,
  database: DATABASE,
  errors: ERRORS,
  'public-routes': PUBLIC,
  'outbound-http': OUTBOUND,
  frontend: FRONTEND,
  config: CONFIG,
};

export function apiGuide(topic: Topic): string {
  return `${GUIDES[topic]}\n\nOther topics: ${TOPICS.filter((t) => t !== topic).join(', ')}.\n\n${API_RULES}`;
}
