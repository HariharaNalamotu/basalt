# Basalt API

The backend framework apps on Basalt build their endpoints with, and the MCP tools a coding agent uses to provision and operate it. Auth is enforced on every route, the origin can only be reached through the platform edge, inputs and outputs are validated, the database enforces data ownership, and HTTP semantics are correct. These are defaults the agent can't easily get wrong.

```
api/
  packages/framework   @basalt/api       createApi(), serve(), client, dev edge, basalt-migrate
  packages/mcp         @basalt/api-mcp   api_* MCP tools + LocalPlatform (also mounts auth_* tools)
  scripts/e2e-plug-and-play.mjs   an "agent" provisions, scaffolds, runs and operates an app via MCP
```

## What the agent does

1. `api_setup { app, origins }` provisions everything in one idempotent call: the auth project, the edge secret, a Postgres database with an admin role and a restricted runtime role, database-enforced ownership, Redis and every env var. Secrets go to the platform's env store and are never shown to the agent.
2. `api_scaffold` returns complete, working files: a server entry, a CRUD route module, a protected-table migration, the frontend client and scripts.
3. It writes routes in the same style. `api_review_code` checks them, and `api_status` verifies the deployment (env, auth origins, database protection, runtime role, unprotected tables, live routes with their effective policy).
4. It changes behavior without code via `api_update_config`, `api_set_route_policy`, `api_set_maintenance` and `api_rotate_edge_secret`.

The entire server wiring an app needs:

```ts
import { createApi } from '@basalt/api';
import { serve } from '@basalt/api/serve';
import { registerTodoRoutes } from './routes/todos.ts';

const api = createApi(); // everything comes from what api_setup provisioned
registerTodoRoutes(api);
serve(api);
```

```ts
api.post('/todos', {
  body: z.object({ title: z.string().trim().min(1).max(200) }),
  response: Todo,      // allow-list of fields sent to clients
  status: 201,
}, async ({ sql, body }) => toTodo(await sql.one`INSERT INTO todos (title) VALUES (${body.title}) RETURNING *`));
// No auth option = signed-in user required. owner_id is filled in and enforced by Postgres.
```

## Guarantees

| Area | Behavior |
|---|---|
| **Auth by default** | Every route requires a verified session (cookie or bearer) unless it explicitly declares `auth: 'public'` or `'optional'`. Routes can also demand MFA, a verified email, recent re-authentication (`maxAgeSeconds`) or a live-session check (`strict`). Handlers never see `Cookie`/`Authorization` headers. |
| **Not reachable directly** | The backend accepts only requests HMAC-signed by the platform edge (method, path, query, request id, 60 s window). Anything else gets 403 `direct_access_forbidden`, even with valid cookies. Production refuses to start without `BASALT_EDGE_SECRET`. |
| **Cross-site protection** | Writes from foreign origins are rejected with 403, even on public routes. CORS is exact-match allow-list only, and JSON bodies are required (forcing a CORS preflight). |
| **Data ownership** | `ctx.sql` runs in a lazily opened per-request transaction carrying the user's data grant. Postgres row-level security returns only the user's rows, even for queries with no `WHERE`. Public routes run without a grant. Writing rows owned by others gives 403, and other users' rows give 404. |
| **Injection-proof SQL** | `ctx.sql` is a tagged template, so values always become bind parameters. Composable fragments use the imported `sql` tag. |
| **Validation** | Zod schemas for params, query and body are required by route shape. Unsafe definitions fail at startup: undeclared `:params`, a missing response or body schema, caching on authenticated routes, wildcard paths, out-of-range limits. |
| **No data exposure** | Response schemas strip undeclared fields (`passwordHash`, internal columns). An invalid response becomes a generic 500 and is never sent. |
| **HTTP semantics** | 200/201 (+`Location`)/202/204, 400 bad params / malformed JSON, 401 (+`WWW-Authenticate`), 403, 404, 405 (+`Allow`), 409 (unique/FK violations), 412, 413, 415, 422 (with field-level `details`), 429 (+`Retry-After`), 500 (generic + `requestId`), 503 (load shed / maintenance / serialization conflicts), 504 (timeouts). Postgres errors map automatically. |
| **Abuse limits** | Per-IP ceiling (IPv6 per /64), per-user per-route limits (default 120/min) and stricter public limits (30/min), all shared through Redis with a per-project prefix. |
| **Safe retries** | `Idempotency-Key` on POST/PATCH (required per route for payments). Replays return the original response, a key reused with a different body gives 422, and in-flight duplicates give 409. The browser client adds keys automatically and retries 502/503/504 safely. |
| **Resilience** | Per-route timeouts (`statement_timeout` set to match), load shedding at `maxInFlight`, keep-alive/header timeouts tuned for running behind the edge, graceful SIGTERM shutdown. |
| **Outbound calls** | `ctx.fetch` is SSRF-safe: it checks the address actually connected to (after DNS, on every redirect) against private, loopback, link-local/metadata, CGNAT and reserved ranges, allows ports 80/443 only, and caps size and time. |
| **Errors and logs** | Error bodies are always `{ error: { code, message, requestId, details? } }` with no internal text in any environment. Logs are structured JSON per request, with secret-looking fields redacted. |
| **Revocation** | Revoked sessions are synced into the database every 10 s, so sign-out, password changes and theft detection cut off data access quickly. |
| **Docs** | OpenAPI 3.1 is generated from the route definitions (`/_basalt/openapi.json`, edge-only in production). |

## Configuration the agent can change (`BASALT_API_CONFIG`)

Code defines what the API is: routes, schemas, and who may call them. Config tunes how it runs. All config is validated and bounded, and invalid config fails at startup.

- `allowedOrigins` (cross-origin callers), `limits` (`maxInFlight`, `defaultTimeoutMs`, `defaultBodyLimitBytes`, `perIp`), `defaultRateLimits` (`user`, `public`), `logLevel`, `revocationSync`
- `routes["POST /todos"]`: `rateLimit`, `timeoutMs`, `bodyLimitBytes`, `auth` (**stricter only**), `disabled` (kill switch → 503)
- `maintenance` (all routes 503 + `Retry-After`; health still passes)

Making a route public is never possible through config. It requires a visible code change.

## Platform integration contract

Implement `ApiPlatform` (`packages/mcp/src/platform.ts`) and mount the tools for the authenticated workspace:

```ts
import { registerApiTools } from '@basalt/api-mcp';
import { registerAuthTools, HttpControlPlane } from '@basalt/auth-mcp';
const auth = new HttpControlPlane(AUTH_URL, PLATFORM_KEY, workspaceId);
registerAuthTools(mcpServer, auth);
registerApiTools(mcpServer, { platform: new HostedPlatform(workspaceId), auth });
```

`ApiPlatform` covers:
- the env/secret store (`readEnv`/`writeEnv`)
- per-app Postgres with two roles (`ensureDatabase`, `adminQuery`)
- Redis (`ensureRedis`)
- the edge configuration (`configureEdge`)
- rollouts (`applyChanges`, which should restart or redeploy on env change)
- signed introspection calls (`callBackend`)

`LocalPlatform` is the reference implementation: real Postgres roles, Redis, and `0600` env files in a git-ignored `.basalt/`.

The edge must:
- route `/_basalt/auth/*` to the auth service (with `X-Forwarded-Prefix: /_basalt/auth`)
- route `/api/*` to the backend, signed with `Basalt-Edge-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "t\nMETHOD\npath?query\nrequestId")>` and `X-Request-Id`
- append the client IP to `X-Forwarded-For`
- strip client-supplied copies of all of those headers

`basalt-dev-edge` (`packages/framework/src/dev-edge.ts`) implements exactly this for local development and is the executable spec. The backend's runtime role must not be a superuser, must not have `BYPASSRLS`, and must not own tables; the SDK refuses to run otherwise in production.

## Development

```bash
cd auth && npm install && npm run build && docker compose up -d --build --wait
cd ../api && npm install && npm test && npm run build
node scripts/e2e-plug-and-play.mjs     # full agent flow against real Postgres/Redis/auth
```

To run the MCP server locally, use `packages/mcp/dist/stdio.js` with `BASALT_AUTH_URL`, `BASALT_AUTH_PLATFORM_KEY`, `BASALT_PG_ADMIN_URL`, `BASALT_REDIS_URL` and an optional `BASALT_STATE_DIR`. It serves both the `auth_*` and `api_*` tools.

## Not yet built

1. Typed end-to-end client generated from route schemas (no hand-written `Todo` types on the frontend).
2. Background jobs/queues with the same auth and ownership model (run as the user, or as a declared system actor).
3. Webhooks in (signature verification helpers) and out (signed, retried delivery).
4. File uploads (direct-to-storage signed URLs) in coordination with the storage feature.
5. Per-tenant (organization) ownership as a first-class `protect()` mode.
6. Hot config reload without restart (today the hosted platform rolls out env changes).
