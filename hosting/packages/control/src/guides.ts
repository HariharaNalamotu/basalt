export const GUIDE_TOPICS = ['workflow', 'project', 'data', 'testing', 'operations', 'security'] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

const workflow = (root: string) => `# Basalt Host — the workflow (you do all of it; the human only describes what they want)

1. **Create the app** (once): \`host_create_app { app: "todo-app" }\`. Production will be https://todo-app.${root}.
2. **Set up the project** (once): \`host_init { app }\` (local tool) writes basalt.json, .npmrc for @basalt packages, a Playwright config and example e2e test. Follow the **project** topic for layout.
3. **Write the app** with @basalt/api (backend) and @basalt/auth (sign-in). Read \`api_integration_guide\` (topics routes, database, frontend) and \`auth_integration_guide\`.
   For anything the app saves per person (bookings, notes, orders, uploads), use the Basalt Data block: read the **data** topic, set the rules on the preview with \`host_data_rules\`, and use \`basalt()\` in the browser or \`ctx.data\` in the backend.
   On Basalt Host provisioning is automatic: ignore api_setup, .basalt/*.env files, basalt-dev-edge and api_status instructions from those guides.
4. **Check your code**: \`api_review_code\` / \`auth_review_code\` on what you wrote. The build blocks critical/high findings anyway.
5. **Deploy**: \`host_deploy { app }\` (local tool) packs the project, builds it (install, security scan, audit, typecheck, lint, unit tests, build), deploys a **private preview**, and runs smoke + your e2e tests. Poll \`host_wait\` until done.
6. **If anything fails**: \`host_deployment\` (failed step output), \`host_build_logs\`, \`host_logs\` (backend), \`host_metrics\`. Reproduce UI problems with \`browser_open\` → \`browser_snapshot\`/\`browser_click\`/\`browser_fill\`/\`browser_screenshot\`/\`browser_console\`/\`browser_network\`. Fix, deploy again.
7. **Verify by hand** on the preview: \`host_test_user\` for credentials, \`host_test_emails\` for verification codes, browser_* tools to click through the main flows. Screenshot key pages and look at them.
8. **Check the data** (if the app saves data): \`host_data_check { app, env }\` (local tool) on the preview or staging. Fix anything it finds and give the owner the receipt link.
9. **Stage**: \`host_promote { app, deploymentId, to: "staging" }\` — tests run again against staging. \`host_wait\`.
10. **Ship**: \`host_promote { app, deploymentId, to: "production" }\` — only allowed after the same deployment passed in staging. Zero-downtime; smoke-tested; automatic rollback if production errors spike in the next 3 minutes. Shortcut for everything after step 4: \`host_deploy { app, ship: true }\`.
11. **Report** the production URL to the human. If they want to look at staging first, give them \`host_share_link\`.

Rollback any time with \`host_rollback\`. Secrets (API keys) via \`host_set_secret\`, never in code.
`;

const project = (registry: string) => `# Basalt Host — project layout (conventions the build relies on)

\`\`\`
package.json            "type": "module"; scripts: "build" (frontend), optional "typecheck", "lint", "test" (unit)
package-lock.json       commit it (reproducible builds)
.npmrc                  @basalt:registry=${registry}   (host_init writes it)
basalt.json             optional: { "backend": { "entry": "server/index.ts" }, "frontend": { "output": "dist" } }
server/index.ts         backend entry: createApi() + routes + serve(api)   (Node runs TypeScript directly)
server/routes/*.ts      route modules (import with .ts extensions)
db/migrations/NNN_*.sql applied automatically with the admin role before each release
src/ , index.html       frontend (e.g. Vite + React); "build" must write dist/index.html
public/index.html       plain static site without a build step (alternative)
e2e/*.spec.ts           Playwright tests, run against every preview and staging deploy
playwright.config.ts    optional; the platform sets baseURL, https and the access header
\`\`\`

Dependencies: \`@basalt/api\`, \`@basalt/auth\` (from the Basalt registry), \`@playwright/test\` ~1.64.0 (devDependency, must match the platform browsers), \`vitest\` for unit tests (exclude e2e: \`test: { exclude: ['e2e/**', 'node_modules/**'] }\`).

Only what's listed is deployed. Never commit .env files (they're dropped from uploads); use \`host_set_secret\`. Install scripts of dependencies do not run in the build (supply-chain protection): choose packages that work without postinstall.

Backend runtime: Node 24, NODE_ENV=production, 256 MB (512 MB production), read-only filesystem except /tmp, outbound internet only via an HTTPS proxy (automatic for fetch), PORT=3000 (serve() reads it).
`;

const data = `# Basalt Host — the Data block (what the app saves, and who can see it)

Every environment (each preview, staging, production) has its own Basalt data store. Each signed-in person only ever reaches the rows they created, plus rows explicitly shared with them. This is checked inside Postgres on every request with the person's Basalt Auth login, so a bug in app code can't leak one person's data to another. Don't build your own tables for per-person data; don't keep app data in localStorage, files or another database.

**1. Rules** — \`host_data_rules { app, env, rules }\`:
\`\`\`json
{ "tables": { "bookings": {
    "fields": {
      "service":   { "type": "text", "maxLength": 100, "required": true },
      "starts_at": { "type": "timestamp", "required": true },
      "phone":     { "type": "text", "format": "phone" },
      "party":     { "type": "integer", "min": 1, "max": 20 },
      "staff_id":  { "type": "user" },
      "photo":     { "type": "file" } },
    "shareWith": "staff_id" } } }
\`\`\`
- Names: lowercase letters, digits, underscores; start with a letter.
- Types: text (maxLength 1–10000, default 1000; format email | phone | url | postal_code | slug), integer / number (min, max), boolean, timestamp (ISO), user (another person's id), file (an uploaded file's id).
- Every row gets id, owner_id, created_at, updated_at automatically.
- shareWith: that user field's person may READ the row (never change it).
- Later changes may only add optional fields or tables. Previews and staging take rules immediately; production returns an approval link for the human owner whenever rules show data to more people. Set the same rules on each environment you deploy to.

**2. Browser** — save this as \`src/basalt.js\` and use it for every read and save. On a Basalt-hosted site it calls \`/_basalt/data\` on the app's own origin with the HttpOnly session cookie (page code never holds a token):
\`\`\`js
export function basalt() {
  async function call(path, init) {
    const res = await fetch('/_basalt/data' + path, { method: 'POST', credentials: 'same-origin', ...init });
    const json = await res.json();
    if (!json.ok) { const err = new Error(json.error.message); err.code = json.error.code; throw err; }
    return json.data;
  }
  const json = (path, body) => call(path, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const op = (name, body) => json('/v1/data/' + name, body);
  return {
    get: (table, id) => op('get', { table, id }),
    // Newest first. { limit, after: page.next, archived: true, where: { field: value | { gte, lt, ... } }, sort: { field, direction } }
    list: (table, options = {}) => op('list', { table, ...options }),
    create: (table, input, options = {}) => op('create', { table, input, ...options }), // { key } makes retries safe
    update: (table, id, input) => op('update', { table, id, input }),
    archive: (table, id) => op('archive', { table, id }), // nothing is ever deleted
    restore: (table, id) => op('restore', { table, id }),
    // PNG, JPEG, GIF, WebP, PDF, text, CSV up to 5 MB; store the returned id in a "file" field.
    upload: (file) => call('/v1/files', { headers: { 'content-type': file.type, 'x-file-name': encodeURIComponent(file.name) }, body: file }),
    fileUrl: async (id) => '/_basalt/data' + (await json('/v1/files/link', { id })).path, // valid 5 minutes
  };
}
\`\`\`
Errors: \`err.code\` is invalid_input, not_found, denied, rate_limited or unavailable; \`err.message\` is plain English. Signed out → denied (send the person to sign in).

**3. Backend** — in a route with auth (the default), \`ctx.data\` has the same get/list/create/update/archive/restore and acts as the signed-in user:
\`\`\`ts
api.post('/bookings', { body: Booking }, async (ctx) => ctx.data.create('bookings', ctx.body));
\`\`\`

**4. Check** — \`host_data_status\` (rules in plain English + the owner's data map link), \`host_data_admin\` (owner approves someone seeing everything), \`host_data_check\` (Guard: real test people and a stranger attack the data; also scans your folder for data kept elsewhere). Run host_data_check on staging before production and give the owner the receipt link.
`;

const testing = `# Basalt Host — testing

**Automatic**: every preview and staging deploy runs smoke tests (home page, security headers, backend health, API reachable) and your Playwright suite.

**Writing e2e tests** (\`e2e/*.spec.ts\`):
\`\`\`ts
import { test, expect } from '@playwright/test';

test('a signed-in user can add a todo', async ({ page }) => {
  await page.goto('/signin');
  await page.getByLabel('Email').fill(process.env.TEST_USER_EMAIL!);
  await page.getByLabel('Password').fill(process.env.TEST_USER_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your todos' })).toBeVisible();
  await page.getByPlaceholder('What needs doing?').fill('Buy milk');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Buy milk')).toBeVisible();
});
\`\`\`
- \`baseURL\` points at the environment; use relative paths.
- \`TEST_USER_EMAIL\` / \`TEST_USER_PASSWORD\`: a fresh verified account per run.
- Tests can only reach your app (no internet): mock third-party calls.
- Results: \`host_deployment\` → tests (failures with messages).

**Driving the site yourself** (preview/staging only):
\`browser_open { app, env }\` → returns sessionId + accessibility snapshot. Target elements by \`{ role, name }\` from the snapshot (e.g. \`{ role: "button", name: "Sign in" }\`), or label/placeholder/text. After actions you get the new snapshot. Use \`browser_screenshot\` to see the page, \`browser_console\` and \`browser_network\` to find errors. \`host_test_user\` gives credentials; \`host_test_emails\` shows verification/reset codes so you can test sign-up and password reset end to end.
`;

const operations = `# Basalt Host — operating an app

| Need | Tool |
|---|---|
| What's deployed where | host_status, host_releases |
| Errors / behaviour | host_logs, host_metrics |
| Undo a bad release | host_rollback (instant) |
| API keys and other secrets | host_set_secret (env "all" / "staging" / "production"), host_secrets, host_delete_secret |
| Backend limits, per-route rate limits, maintenance mode | host_update_api_config, host_route_policy |
| Traffic spike / attack | host_protection { underAttack: true } (browser challenge), lower perIpPerMinute, maxConcurrency |
| Load third-party scripts/APIs in the frontend | host_csp { connectSrc, scriptSrc, frameSrc, ... } |
| Let a human see staging | host_share_link |
| Clean up | host_delete_env (previews are also deleted automatically after 24h) |

Previews and staging sleep after 30 idle minutes and wake on the next request (a few seconds). Production never sleeps. Secret and config changes roll out with a zero-downtime restart.
`;

const security = `# Basalt Host — what the platform enforces (you get this for free; don't re-implement it)

- **Edge** (behind Cloudflare): TLS, DDoS absorption, per-IP and per-app rate limits, connection caps, automatic bans for exploit scanners and attack signatures, optional proof-of-work challenge, strict security headers and CSP, HSTS, source maps and dotfiles never served.
- **Isolation**: every environment has its own private network, database (restricted runtime role + row-level security), Redis ACL user and auth project. Backends cannot reach the internal network, other apps or the host machine; outbound internet goes through a proxy that blocks private addresses (SSRF) and non-web ports.
- **Containers**: non-root, read-only filesystem, no Linux capabilities, no privilege escalation, memory/CPU/process limits.
- **Builds**: sandboxed, network only to the package registry, dependency install scripts disabled, critical vulnerabilities and hardcoded secrets block the build, code review rules block critical/high findings.
- **Releases**: zero downtime, smoke-tested, automatic rollback on failure, production only after staging tests pass.
- **Private test environments**: previews and staging require a signed access link; never indexed.

Your responsibilities: follow api_security_rules and auth_security_rules, protect per-user tables with basalt_auth.protect(), keep secrets in host_set_secret, write e2e tests for the important flows.
`;

export function hostGuide(topic: GuideTopic, root: string, registry = `https://registry.${root}/`): string {
  switch (topic) {
    case 'workflow':
      return workflow(root);
    case 'project':
      return project(registry);
    case 'data':
      return data;
    case 'testing':
      return testing;
    case 'operations':
      return operations;
    case 'security':
      return security;
  }
}
