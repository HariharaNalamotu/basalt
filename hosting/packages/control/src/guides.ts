import { design } from './design-guide.js';
export const GUIDE_TOPICS = ['workflow', 'project', 'data', 'design', 'testing', 'operations', 'security'] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

const workflow = (root: string) => `# Basalt Host — the workflow (you do all of it; the human only describes what they want)

1. **Create the app** (once): \`host_create_app { app: "todo-app" }\`. Production will be https://todo-app.${root}.
2. **Set up the project** (once): \`host_init { app }\` (local tool) writes basalt.json, .npmrc for @basalt packages, a Playwright config and example e2e test. Follow the **project** topic for layout.
3. **Decide what the app saves** before writing data code: read the **data** topic. Ask the human a few short plain questions (what it keeps track of, what each thing needs, who else should see an entry), write \`basalt.data.json\` and save data from the page through \`/_basalt/data\`. Most apps (bookings, orders, sign-ups, notes, including "no double bookings") need no backend at all. Use the Data block unless the app truly needs code on a server.
   **Design it** before writing any page: read the **design** topic (a palette and type from the business, a local CSS starter, tappable time slots, every save outcome designed).
   **Write the app** with @basalt/auth (sign-in) and, only for logic that must run on a server, @basalt/api (backend). Read \`api_integration_guide\` (topics routes, database, frontend) and \`auth_integration_guide\`.
   On Basalt Host provisioning is automatic: ignore api_setup, .basalt/*.env files, basalt-dev-edge and api_status instructions from those guides.
4. **Check your code**: \`api_review_code\` / \`auth_review_code\` on what you wrote. The build blocks critical/high findings anyway.
   **No local install is needed**: don't run npm install on the human's computer. \`host_deploy\` installs dependencies and builds on the platform (a missing package-lock.json is only a warning).
5. **Deploy**: \`host_deploy { app }\` (local tool) packs the project, builds it (install, security scan, audit, typecheck, lint, unit tests, build), deploys a **private preview**, and runs smoke + your e2e tests. Poll \`host_wait\` until done.
6. **If anything fails**: \`host_deployment\` (failed step output), \`host_build_logs\`, \`host_logs\` (backend), \`host_metrics\`. Reproduce UI problems with \`browser_open\` → \`browser_snapshot\`/\`browser_click\`/\`browser_fill\`/\`browser_screenshot\`/\`browser_console\`/\`browser_network\`. Fix, deploy again.
7. **Verify by hand** on the preview: \`host_test_user\` for credentials, \`host_test_emails\` for verification codes, browser_* tools to click through the main flows. Screenshot key pages and look at them on a phone and on a desktop, light and dark: \`browser_open { app, env, viewport: "phone", colorScheme: "dark" }\`, then again with \`viewport: "desktop"\`. Run the design topic's pre-ship checklist and fix what you see before telling the human it's done.
8. **Check the data** (if the app saves data): \`host_data_check { app, env }\` (local tool) on the preview or staging. Fix anything it finds and give the owner the receipt link.
9. **Stage**: \`host_promote { app, deploymentId, to: "staging" }\` — tests run again against staging. \`host_wait\`.
10. **Ship**: \`host_promote { app, deploymentId, to: "production" }\` — only allowed after the same deployment passed in staging. Zero-downtime; smoke-tested; automatic rollback if production errors spike in the next 3 minutes. Shortcut for everything after step 4: \`host_deploy { app, ship: true }\`.
11. **Report** the production URL to the human. If they want to look at staging first, give them \`host_share_link\`.

Rollback any time with \`host_rollback\`. Secrets (API keys) via \`host_set_secret\`, never in code.
`;

const data = (root: string) => `# Basalt Host: saving data (the Data block)

Every environment has its own locked down database. Each signed-in person only ever reaches their own entries (or ones shared with them read only), and the database itself checks every request, so no bug in the page or backend can widen access. Use it for everything the app saves. Never keep app data in localStorage, files or another database.

## 1. Ask, then write the rules

Ask the human in plain words, one question at a time: what the app keeps track of, what each thing needs to remember, which details are must-haves, and whether one other person (like the staff member a booking is assigned to) should be able to see an entry. Never mention databases or code. Then write **basalt.data.json** in the project root:

\`\`\`json
{ "tables": { "bookings": {
    "fields": {
      "service":   { "type": "text", "maxLength": 100, "required": true },
      "starts_at": { "type": "timestamp", "required": true },
      "phone":     { "type": "text", "format": "phone" },
      "staff_id":  { "type": "user" }
    },
    "shareWith": "staff_id",
    "unique": [["starts_at", "staff_id"]]
} } }
\`\`\`

Names: lowercase letters, numbers and underscores. Types: "text" (maxLength up to 10000, default 1000; optional "format": "email" | "phone" | "url" | "postal_code" | "slug"), "integer" and "number" (optional "min", "max"), "boolean", "timestamp" (ISO), "user" (another person's user id) and "file" (an uploaded file's id). Every row gets id, owner_id, created_at and updated_at automatically. "shareWith" names a "user" field whose person can read (never change) that row. "unique" lists groups of required fields no two active entries may share across everyone, like \`"unique": [["starts_at"]]\` so two customers can't book the same time (archived entries don't count, so cancelling frees the slot). This needs no backend: the database refuses a clash with err.code "conflict" without revealing whose entry it is.

Don't make personal details unique (email, phone, name): a clash tells whoever tried that the value is taken, so it would let anyone check whether someone is a customer. Unique is for things like time slots, seat numbers and order numbers.

Later changes may only add optional fields or tables. Removing a field, making one required or changing its rules is refused.

## 2. What happens on deploy

Preview and staging take the rules right away, before your tests run. Promoting to production stops with an approval link when the rules would show data to more people: show it to the human, they tap "Yes", then promote again. After the tests, **Guard** attacks every preview and staging deploy's data (other people's entries, forged and expired logins, sneaky searches). Anything that gets through stops the deploy, and production needs Guard to pass in staging. \`host_data_check\` (local tool) runs it on demand on preview or staging, also scans this folder for data kept outside Basalt, and returns the owner's safety receipt link: give it to them. \`host_data_status\` shows the rules in plain English and the owner's data map link (share it only with the owner). \`host_data_admin\` asks the owner to let one person see and change everything (always an approval link). \`host_data_rules\` sets rules by hand on one environment without deploying.

## 3. Saving from the page

Save this as **public/basalt.js** (or src/basalt.js with a build). The browser sends the signed-in session cookie automatically, so page code never holds a token:

\`\`\`js
// basalt.js: the only way this app reads or saves data.
export function basalt() {
  async function call(path, body, init = {}) {
    const res = await fetch('/_basalt/data' + path, { method: 'POST', credentials: 'same-origin', ...init, body });
    const json = await res.json();
    if (!json.ok) { const err = new Error(json.error.message); err.code = json.error.code; throw err; }
    return json.data;
  }
  const op = (name, body) => call('/v1/data/' + name, JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  return {
    get: (table, id) => op('get', { table, id }),
    // Newest first. Options: { limit, after: page.next, archived: true, where: { service: 'Color', starts_at: { gte: '...' } }, sort: { field, direction } }
    list: (table, options = {}) => op('list', { table, ...options }),
    // Pass { key } (like an order number) so a retry never saves twice.
    create: (table, input, options = {}) => op('create', { table, input, ...options }),
    update: (table, id, input) => op('update', { table, id, input }),
    // Nothing is deleted: archive hides an entry (a cancelled booking), restore brings it back.
    archive: (table, id) => op('archive', { table, id }),
    restore: (table, id) => op('restore', { table, id }),
    // PNG, JPEG, GIF, WebP, PDF, text and CSV up to 5 MB. Save the returned id in a "file" field.
    upload: (file) => call('/v1/files', file, { headers: { 'content-type': file.type, 'x-file-name': encodeURIComponent(file.name) } }),
    // A link for <img src> or downloads, good for 5 minutes.
    fileUrl: async (id) => '/_basalt/data' + (await call('/v1/files/link', JSON.stringify({ id }), { headers: { 'content-type': 'application/json' } })).path,
  };
}
\`\`\`

Use it like \`const db = basalt(); await db.create('bookings', { service: 'Haircut', starts_at: new Date().toISOString() });\`. Sign people in first (see auth_integration_guide: POST /_basalt/auth/signin sets the cookie). err.code is invalid_input, not_found, denied, conflict (a unique value is already taken: show err.message and let them pick another), rate_limited or unavailable, and err.message says what's wrong in plain words.

On a backend (@basalt/api), the same operations are \`ctx.data\` as the signed-in user.

Test the main data flows in e2e/ (sign in with TEST_USER_EMAIL / TEST_USER_PASSWORD, save something, see it).
`;

const project = (registry: string) => `# Basalt Host — project layout (conventions the build relies on)

\`\`\`
package.json            "type": "module"; scripts: "build" (frontend), optional "typecheck", "lint", "test" (unit)
package-lock.json       commit it (reproducible builds)
.npmrc                  @basalt:registry=${registry}   (host_init writes it)
basalt.json             optional: { "backend": { "entry": "server/index.ts" }, "frontend": { "output": "dist" } }
basalt.data.json        what the app saves and who can see it (see the data topic)
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
    case 'data':
      return data(root);
    case 'design':
      return design;
    case 'project':
      return project(registry);
    case 'testing':
      return testing;
    case 'operations':
      return operations;
    case 'security':
      return security;
  }
}
