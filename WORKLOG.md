# Basalt: complete work log

Basalt is a platform of standard, secure building blocks for apps that people with no coding experience build with Claude Code. Claude drives everything through one MCP connector. The person building never runs a command; the only things they do are describe what they want and tap "Yes" on approval pages. The rules that keep one customer's data from another's live below the app's code, in Postgres and at the edge, and are deterministic: there is no AI inside Basalt.

This document records everything built in this repository up to 2026-10-24, how the parts fit together, how to deploy it and how it was verified. Sections 1 to 12 are the narrative and the cross-cutting picture. Appendices A to C are exhaustive per-service inventories (routes, schemas, parameters, limits, tests), checked against the code.

**State at the time of writing**
- Branch `hari`.
- All five services build and pass their tests:
  - Auth: 116
  - API: 75
  - Hosting: 52
  - Data: 104
  - Cloud: 51
- The full platform end-to-end run passes all 47 checks in 168 s on a fresh one-laptop stack, and leaves nothing behind.
- The MCP connector installs from the platform's own registry with `npx` and exposes 54 tools.
- Demo mode was verified in a real Chromium: sign-in, saving data, and the owner approval flow.

---

## Contents

1. [Timeline](#1-timeline)
2. [Architecture](#2-architecture)
3. [Identity, tokens and keys](#3-identity-tokens-and-keys)
4. [Request flows](#4-request-flows)
5. [The services in brief](#5-the-services-in-brief)
6. [Making Auth, Data, Cloud and Hosting one system](#6-making-auth-data-cloud-and-hosting-one-system)
7. [The MCP connector](#7-the-mcp-connector)
8. [Deployment runbook](#8-deployment-runbook)
9. [Security model](#9-security-model)
10. [Verification](#10-verification)
11. [Deployment-readiness pass (2026-10-24): every change and every bug found](#11-deployment-readiness-pass-2026-10-24)
12. [Known limitations and open items](#12-known-limitations-and-open-items)
- [Appendix A: Basalt Auth and Basalt API inventory](#appendix-a-basalt-auth-and-basalt-api)
- [Appendix B: Data block and Basalt Cloud inventory](#appendix-b-data-block-and-basalt-cloud)
- [Appendix C: Basalt Host inventory](#appendix-c-basalt-host)

---

## 1. Timeline

**Ownership.** Hari built Auth, API and Hosting, and the cross-service integration. Mihir built the Data block and Cloud. Mihir's work went through several Codex review rounds, and every finding was fixed.

**Size.** The repository has 264 tracked files. There are about 27,000 lines of TypeScript, SQL, shell and YAML.

### Hari's branch: Auth, then the API framework

| # | Commit | Author | What landed | Size |
|---|---|---|---|---|
| 1 | `3d29afd` | Hari | **Basalt Auth server**: Hono + Postgres + Redis, multi-tenant projects. Argon2id passwords, Ed25519 access JWTs with JWKS, rotating HMAC refresh tokens with reuse detection, TOTP MFA plus recovery codes, email codes, anti-enumeration, rate limits, audit log | 43 files, +6,367 |
| 2 | `f425d89` | Hari | **`@basalt/auth` SDK**: browser client (cookie-only, auto-refresh, cross-tab), backend verifier (JWKS, CSRF origin check, strict mode), React bindings. Owner-scoped control plane (`X-Basalt-Owner`) | 16 files, +1,274 |
| 3 | `5be940d` | Hari | **Auth MCP tools** (16 `auth_*` tools, guides, static code reviewer), Dockerfile, compose, CI workflow, docs. Hardened rate limiting (Lua sliding window, hashed keys) | 27 files, +2,827 |
| 4 | `5704a9f` | Hari | **Database-enforced data ownership**: session-bound data grants (`bdg` claim), the `basalt_auth` schema installed into the app's Postgres, `protect()` forced RLS, `withUserDb`, a revocation feed with sync. Step-up re-authentication (`auth_time`, `maxAgeSeconds`) | 24 files, +1,451 |
| 5 | `ecef689` | Hari | **`@basalt/api` framework**, `createApi`. Covers the following: <ul><li>auth required by default</li><li>edge-only (HMAC-signed requests)</li><li>Zod-validated params, query, body and response</li><li>`ctx.sql` inside a per-request RLS transaction carrying the user's grant</li><li>idempotency keys, rate limits, load shedding and timeouts</li><li>SSRF-safe fetch, OpenAPI</li></ul> | 26 files, +4,762 |
| 6 | `b05e0f2` | Hari | **API MCP provisioning**: 11 `api_*` tools, `LocalPlatform`, `setupApp`. Agent-managed `BASALT_API_CONFIG` that can only tighten auth. Dev edge, `basalt-migrate`, plug-and-play e2e | 24 files, +3,357 |

### Mihir's Data block and Cloud (merged as PR #1)

| # | Commit | Author | What landed | Size |
|---|---|---|---|---|
| 7 | `055fc91` | Mihir | **Data block**: get, list, create, update over Postgres, with a contract registry and RLS | 20 files, +1,426 |
| 8 | `cbbc988` | Mihir | Data block hardened and scaled after two Codex reviews | 19 files, +1,187/−255 |
| 9 | `66a6360` | Mihir | All data access goes through one locked function, `basalt.api(token, op, table, args)` | 19 files, +850/−453 |
| 10 | `6f7a375` | Mihir | Per-app database roles (owner, exec, data) | 7 files |
| 11 | `c3dc66b` | Mihir | **Basalt Cloud**: one database per app, plain-English approvals, the standalone `basalt_*` MCP | 13 files, +1,388 |
| 12 | `62e69cf` | Mihir | Admin role; archive instead of delete | 13 files |
| 13 | `e16ad03` | Hari | Merge PR #1 (`data-block`) | |

### Hari's API CI fix and hosting prerequisites

| # | Commit | Author | What landed | Size |
|---|---|---|---|---|
| 14 | `325cbee` | Hari | **CI fix (api)**: build before typecheck, so `@basalt/api-mcp` resolves the built `@basalt/api` types | |
| 15 | `2baac5d` | Hari | Hosting prerequisites: test users via the platform API, `BASALT_AUTH_INTERNAL_URL`, `include` filters on the tool sets | 6 files |

### Mihir's data features: filters, uploads, data map, Guard

| # | Commit | Author | What landed | Size |
|---|---|---|---|---|
| 16 | `5dced04` | Mihir | Filters and sorting on `list` | 6 files |
| 17 | `dcc07f3` | Mihir | File uploads: magic-byte checks, quotas, 5-minute links | 13 files, +657 |
| 18 | `9a87600` | Mihir | The owner's data map | 6 files |
| 19 | `a7ed98e` | Mihir | **Guard**: the live attack check and safety receipt | 10 files, +699 |
| 20 | `9dfb4bf`, `d942f70` | Mihir | Cloud README; Guard receipt made honest after review | |

### Basalt Host and the cross-service integration

| # | Commit | Author | What landed | Size |
|---|---|---|---|---|
| 21 | `c2cca94` | Hari | **Basalt Host**. Covers the following: <ul><li>control plane, edge, egress proxy, browser worker and local MCP</li><li>sandboxed CI and per-environment networks</li><li>previews, staging and production</li><li>the private-environment gate, share links, proof-of-work under-attack mode</li><li>a Verdaccio registry and a Cloudflare Tunnel</li></ul> | 90 files, +9,684 |
| 22 | `1e1d423` | Hari | **Auth ↔ Data ↔ Cloud integration** (in-progress work committed by Hari). <ul><li>One HS256 data token verified by both in-database verifiers</li><li>revocation sync into Data databases</li><li>Cloud apps bound to real Auth projects, with test logins as real Auth users</li><li>`ctx.data`</li></ul> | 21 files, +946 |

### Mihir's merge of the integration and hosted data (merged as PR #2)

| # | Commit | Author | What landed | Size |
|---|---|---|---|---|
| 23 | `77e315e`…`076559f` | Mihir | Merged the Auth sync. Then: <ul><li>the Data block served on hosted apps at `/_basalt/data`</li><li>`host_data_rules`</li><li>provisioning made safe to retry (`externalId` = environment id)</li><li>a pool deadlock fixed</li><li>four Codex review rounds</li></ul> | |
| 24 | `7d249ed` | Mihir | Repo README and the one-laptop demo mode (`setup.sh … --local`) | |
| 25 | `34a66ce` | Hari | Merge PR #2 (`features-guard-map-filters-uploads`) | |

### Verification and the deployment-readiness pass (2026-10-24)

| # | Commit | Author | What landed | Size |
|---|---|---|---|---|
| 26 | `569a411` | Hari | Hosting e2e covers the hosted Data block path; lockfile sync | |
| 27 | `bea69d5`, `77e8413` (PR #4) | Hari | **Deployment readiness** (§11). <ul><li>one MCP connector covering data (`host_data_status`, `host_data_admin`, `host_data_check`, the `data` guide)</li><li>a correct connector setup printout</li><li>a working local demo origin</li><li>registry tarball URLs fixed</li><li>demo-mode test browsers and browser tools fixed</li><li>a Cloud crash on app deletion fixed</li><li>health-gated startup</li><li>CI for hosting, Data and Cloud</li><li>this document</li></ul> | 33 files, +527/−85, plus new files |
| 28 | PR #3 → PR #5 | Mihir, merged by Hari | **Rules as code, Guard as a deploy gate, unique fields** (§11b). Mihir's PR #3 merged onto main with its conflicts and bugs fixed | |

### Earlier issues found and fixed (before this pass)

- **API CI was failing.** `@basalt/api-mcp` typechecked against `@basalt/api` before that package was built. The fix was to build first, then typecheck, then test (`.github/workflows/api.yml`).
- **`ctx.data` returned 503 for signed-out users.** The data token is now resolved before the network call, so "not signed in" maps to 401.
- **Postgres rejected a JWT shape regex.** Repetition counts above 255 aren't allowed in Postgres regexes. The regex now uses `+` plus an explicit length check (`length <= 4096`, signature `{43}`).
- **A template literal dropped backslashes.** In the SQL template inside a JS template string, `\.` became `.`. It is now written as `\\.`.
- **Test clock skew.** Tests now keep simulated skew inside the verifier's 60 s `iat` allowance.
- **Hosting teardown could hang.** It now runs in this order: containers, then auth, Data project, Redis user, database, network disconnect, network. The auth DELETE uses `connection: close`, and Docker calls have 60 s timeouts. Deleting an environment takes about 1 s.
- **Cloud tests:**
  - They now import `pg` through `../../data/src/index.ts`.
  - Their assertions were updated for the signing secret now living in Auth.

---

## 2. Architecture

```
                         Internet
                            │  (Cloudflare: TLS, DDoS absorption)
                    ┌───────▼────────┐
                    │  cloudflared   │  profile "tunnel", core IP 10.200.0.250, the only ingress
                    └───────┬────────┘
                            │ http :8080
┌───────────────────────────▼──────────────────────────────────────────────────────────────┐
│ edge (basalt-edge)  public :8080 · internal TLS :443 (self-signed, for tests/browser) · admin :9090  │
│  routing by Host: <app>[--<env>].<root> → app · registry./cloud./host.<root> → services   │
│  rate limits, bans, WAF-lite, PoW under-attack, private gate (x-basalt-access / share     │
│  link cookie), static files + CSP, /_basalt/auth → auth, /_basalt/data → cloud /p/<id>,   │
│  /api/* → backend container (HMAC-signed), wake-on-request                                │
└──┬──────────────┬───────────────┬──────────────┬───────────────┬─────────────────────────┘
   │              │               │              │               │
┌──▼───┐   ┌──────▼──────┐  ┌─────▼─────┐  ┌─────▼──────┐  ┌─────▼──────┐
│ auth │   │ cloud       │  │ control   │  │ verdaccio  │  │ app        │ one hardened container per
│:8787 │◄──┤ :8790       │◄─┤ :4000 pub │  │ :4873      │  │ backends   │ live release, on its env's
│      │   │ Data block  │  │ :4001 int │  │ @basalt/*  │  │ :3000      │ own internal network
└──┬───┘   │ per-app DBs │  │ Docker API│  │ + npm proxy│  └─────┬──────┘ 10.201.N.0/24
   │       └──────┬──────┘  └─────┬─────┘  └────────────┘        │ outbound only via
┌──▼──────────────▼───────────────▼──┐   ┌─────────┐  ┌──────────▼──┐
│ postgres 17 (platform + per-app DBs│   │ redis 7 │  │ egress :3128│ blocks private, metadata,
│ basalt_host, basalt_auth, app_*,   │   │ ACL user│  │ HTTPS proxy │ LAN and non-web ports
│ basalt_<app>_<env>)                │   │ per env │  └─────────────┘
└────────────────────────────────────┘   └─────────┘   browser worker :7070 (Playwright Chromium)
```

### Services and ports

All services are in `hosting/deploy/docker-compose.yml`.

| Service | Ports and role |
|---|---|
| postgres | 5432. One server holds: <ul><li>`basalt_host`: control-plane state</li><li>`basalt_auth`: Auth</li><li>`app_<id>`: one Cloud Data database per environment</li><li>`basalt_<app>_<env>`: each environment's own backend database</li></ul> |
| redis | 6379, with one ACL user per environment |
| verdaccio | 4873 |
| auth | 8787 |
| cloud | 8790 |
| control | 4000 (public API and `/mcp`) and 4001 (internal: routes, wake, mail webhook) |
| edge | 8080 (public), 443 (internal TLS) and 9090 (admin) |
| egress | 3128 |
| browser | 7070 |
| cloudflared | Profile `tunnel` only |

### Networks

| Network | Internal | Subnet | Purpose |
|---|---|---|---|
| `core` | yes | 10.200.0.0/24 | All platform services |
| `basalt_build` | yes | 10.200.1.0/24 | Build sandboxes reach only Verdaccio |
| `outbound` | no | default | Internet access: verdaccio, control, egress, cloudflared, and the edge in local mode |
| One per environment | yes | 10.201.N.0/24 | The environment's backend container plus the infra containers (postgres, redis, auth, edge, egress, cloud) as aliases |
| One per e2e run | yes | — | The Playwright test container and the edge only |

### Hardening on every service

- `no-new-privileges`
- `restart: unless-stopped`
- Rotated JSON logs (20 MB × 5)
- edge, egress and cloud run `read_only` with `cap_drop: [ALL]`.
- The control plane runs as root because it holds the Docker socket. It executes no user code.

### Health

As of this pass:
- postgres, redis, auth, cloud (`/healthz`), control (`/v1/health`) and edge (any HTTP answer on :8080) have healthchecks.
- Start order is gated on health: postgres and redis, then auth, then cloud, then control, then edge.
- `setup.sh` uses `up --wait`.

---

## 3. Identity, tokens and keys

### Token chain

One sign-in produces one identity that every layer checks independently:

1. **Access token.**
   - Auth issues an Ed25519 JWT (`typ: at+jwt`, `kid`). It is published via JWKS at `/v1/projects/<id>/.well-known/jwks.json`.
   - Claims: `iss = <AUTH PUBLIC_URL>/v1/projects/<id>`, `aud = <projectId>`, `sub`, `sid`, `email`, `email_verified`, `amr`, `auth_time`, `exp` (default 10 min, maximum 1 h) and **`bdg`**.
   - Browsers only ever hold it in the HttpOnly cookie `__Host-basalt_at` (SameSite=Lax, Path=/).
2. **Data grant `bdg`.**
   - An HS256 JWT signed with the project's own 32-byte data key. The key is used as text: HMAC key = UTF-8 of base64url(key).
   - Header: `{alg: HS256, typ: JWT, kid: "v<N>"}`.
   - Payload: `{sub, sid, iat, exp (= access token exp), aud: "authenticated", role: "authenticated", iss}`.
   - It never appears in page JS. On the backend it is held in a `WeakMap` beside the user object, never on it.
3. **Verification in Postgres.** Two independent verifiers check the same token:
   - `basalt_auth.uid()` is installed by Auth into an app's own database, for `ctx.sql` and `withUserDb`. It is extension-free: HMAC via built-in `sha256()` with pre-padded `k_ipad` and `k_opad`.
   - `basalt.uid()` is in every Cloud Data database, for `/_basalt/data` and `ctx.data`. It uses pgcrypto.
   - Both enforce:
     - canonical base64url
     - signature comparison via a digest (constant time)
     - `alg = HS256`, no `crit`
     - `aud = role = authenticated`, `iss` equals the stored issuer
     - integer `exp`/`iat`, `exp − iat ≤ 3600`, `iat ≤ now + 60`, `exp > now`
     - `sid` not in revoked sessions
   - Any failure means no rows. The Auth verifier raises SQLSTATE 28000; the Data verifier returns NULL, which makes every policy deny.
4. **Revocation.**
   - A trigger on `auth_sessions` records every way a session ends (sign-out, password change or reset, disable, delete, refresh-token theft) in `auth_session_revocations`.
   - Consumers pull the feed (`/data-protection/revocations`, keyset-paged, 2 h horizon, 30 s overlap) every 10 s:
     - The SDK's `startRevocationSync` writes to `basalt_auth.record_revocations`.
     - Cloud's sync loop writes to `basalt.record_revocations` in every app database.
   - So a stolen cookie stops working in every database within about 10 s, not at expiry.
5. **Refresh token.**
   - Format: `bslt_rt_<sid>_<generation>_<HMAC(session secret, sid:generation)>`. The browser holds it only in `__Secure-basalt_rt`, with `Path=<prefix>/session` and SameSite=Strict.
   - Rotation on every use.
   - Replaying the previous generation within 10 s returns 409 `refresh_in_progress`, which covers racing tabs.
   - Any other replay of an old generation revokes the session as theft.

### Secrets inventory

Generated by `setup.sh` into `hosting/deploy/.env` with `umask 077`.

| Secret | Format | Used by | Protects | Stored |
|---|---|---|---|---|
| `AUTH_MASTER_KEY` | base64, 32 B | auth | HKDF subkeys: AES-256-GCM for signing keys, refresh secrets, TOTP secrets and data keys (each with AAD); a pepper for email, recovery and signup codes | .env only |
| `AUTH_PLATFORM_KEY` | hex | auth, control, cloud | The Auth control plane (`/v1/platform`, plus the `X-Basalt-Owner` scope) | .env |
| `HOST_MASTER_KEY` | base64, 32 B | control | Environment secrets, Data admin keys and access keys | .env |
| `CLOUD_MASTER_KEY` | hex | cloud | Each app database's passwords and secrets (AES-256-GCM), and test-user password derivation | .env |
| `CLOUD_PLATFORM_KEY` | hex | cloud, control | Cloud's `/api/platform/*` (control plane only; refused if the request came through the edge, i.e. carries X-Forwarded-For) | .env |
| `INTERNAL_TOKEN` | hex | control, edge, browser | Route table, wake, edge admin, browser worker | .env |
| `EDGE_KEY` | hex | edge | Signs challenge clearance and access cookies | .env |
| `MAIL_WEBHOOK_SECRET` | hex | auth → control | Signed mail webhook (`t=…,v1=HMAC`, 300 s window) | .env |
| `REGISTRY_PUBLISH_PASSWORD` | hex | control → verdaccio | The single publisher account (`max_users: 1`) | .env |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | hex | infra | Superuser and admin access | .env |
| `CF_TUNNEL_TOKEN` | Cloudflare | cloudflared | Ingress | .env |

### Secrets created at runtime

| Secret | Format | Used by | Protects | Stored |
|---|---|---|---|---|
| Per-environment `BASALT_EDGE_SECRET` | 32 B | edge ↔ backend | `Basalt-Edge-Signature: t=,v1=HMAC(method, path?query, requestId)`, ±60 s; unsigned requests get 403 `direct_access_forbidden` | control DB, encrypted |
| Workspace token `bht_…` | 32 B base64url | Coding agent → control `/mcp` and `/v1` | Everything in one workspace | SHA-256 in the control DB; shown once |
| Cloud admin key `bsk_<id>_…` | — | Control (hosted) or the `.basalt/` folder (standalone) | One Data project's rules and approvals | Encrypted in the control DB (AAD `data:<envId>`) |

---

## 4. Request flows

### a) A person signs in on a hosted app

1. The browser sends `POST https://<app>.<root>/_basalt/auth/signin`.
2. The edge strips spoofable headers and maps the request to `http://auth:8787/v1/projects/<prj>/signin` with `x-forwarded-prefix: /_basalt/auth`.
3. Auth checks:
   - Origin against the project's exact allow-list. For hosted environments this is `https://<host>`, plus the demo origin in local mode.
   - JSON content type.
   - Rate limits per IP, per account+IP and per account.
   - The Argon2id hash, inside a bounded semaphore.
4. Auth sets `__Host-basalt_at` and `__Secure-basalt_rt`. No token is ever in the response body for browsers.

### b) The browser saves data (Data block)

1. Page code calls `fetch('/_basalt/data/v1/data/create', {credentials: 'same-origin'})`.
2. The edge checks:
   - The private-environment gate (for previews and staging).
   - The route allow-list:
     - `POST /v1/data/(get|list|create|update|archive|restore)`
     - `POST /v1/files`
     - `POST /v1/files/link`
     - `GET /v1/files/download/<64 hex>`
   - Body limits: 256 KB, or 6 MB for uploads.
3. The edge forwards to `http://cloud:8790/p/<dataProjectId>/…`. It sends `x-forwarded-host` and `x-forwarded-proto` as the browser saw them, drops the edge's own cookies and never returns `set-cookie`.
4. The Data service:
   - accepts the session cookie only if `Origin` matches the forwarded host (CSRF)
   - extracts `bdg` from the cookie's access token
   - calls `basalt.api(token, op, table, args)`
5. In Postgres:
   - `basalt.api` verifies the token.
   - It charges per-user read and write budgets: 600 reads and 60 writes per minute.
   - RLS limits rows to `owner_id = uid()`, rows shared with the user (read-only), or admins.
   - Values go through `jsonb_populate_record`, never SQL text.
   - An audit row records column names only.

### c) The backend reads its own tables (`ctx.sql`)

1. The edge sends `/api/*` to the backend container with an HMAC signature.
2. `@basalt/api` checks, in order:
   - the signature
   - the origin policy
   - load shedding
   - per-IP limits
   - auth (`requireUser`, plus MFA, email verification and step-up if configured)
   - per-route limits
   - Zod validation
   - idempotency
3. On the first `ctx.sql` it opens `BEGIN; SET LOCAL statement_timeout; SELECT basalt_auth.authenticate(grant)`.
4. Every table protected with `basalt_auth.protect()` has forced RLS: `owner_id = basalt_auth.uid()`. A forgotten `WHERE` clause still only sees the caller's rows.
5. The transaction commits on success and rolls back on error.

### d) The backend uses the Data block (`ctx.data`)

`POST ${BASALT_DATA_URL}/v1/data/<op>` with `Authorization: Bearer <bdg>`. `BASALT_DATA_URL` is written into every environment and points at `http://cloud:8790/p/<id>`. Errors map as:

| Data service error | HTTP status |
|---|---|
| denied | 401 |
| not_found | 404 |
| invalid_input | 422 |
| rate_limited | 429 |
| unavailable | 503 |

### e) The agent deploys

1. `host_deploy` (local tool) packs the project. It honours `.gitignore` and never includes `node_modules`, `.git`, `.env*`, `.npmrc` or build output, with a cap of 50 MB.
2. It uploads the archive with `POST /v1/apps/<app>/sources`.
3. It calls the remote `host_deploy_source`.
4. Control runs CI in a sandbox:
   - extract
   - security scan (blocks hardcoded secrets and critical review findings)
   - detect
   - `npm ci --ignore-scripts` (only the registry is reachable)
   - `npm audit`
   - typecheck, lint, unit tests
   - build
   - package
   - static precompression
   - a COPY-only image
5. Control creates the preview environment:
   - its own network
   - an Auth project with allowed origins
   - a Postgres database with admin and runtime roles, plus `basalt_auth`
   - a Redis ACL user
   - a Cloud Data project bound to the Auth project
   - secrets
6. It runs migrations with the admin role and starts a hardened container.
7. It runs smoke tests and the app's Playwright e2e against the internal TLS edge.
8. `host_promote` moves the deployment to staging (tests again), then to production. Production is only allowed after the same deployment passed staging, uses zero-downtime switchover and a smoke test, and auto-rolls back if errors spike in the next 3 minutes.

---

## 5. The services in brief

Full detail is in the appendices.

### Basalt Auth (`auth/`, Appendix A)

**Parts:** Hono server, an SDK (browser, server and React) and MCP tools. Data lives in Postgres 17; rate limits are kept in Redis.

**Features:**
- Sign-up with emailed 6-digit codes. The account exists only after verification, which defeats pre-hijacking.
- Sign-in with identical errors and dummy hashing, so unknown emails can't be detected.
- Password reset that revokes all sessions.
- TOTP MFA with replay protection, plus 10 recovery codes.
- Step-up re-authentication.
- Session management, a secret-key admin API and an audit log (365-day retention).

**Security parameters:**
- Argon2id: m = 19,456 KiB, t = 2, p = 1.
- Passwords: minimum 10 code points; a common-password list; must not contain the email's local part; HIBP k-anonymity check (fail-open).

**Rate-limit rules** (14 in total), including:

| Rule | Limit |
|---|---|
| Sign-in per account+IP | 10 / 15 min |
| Sign-in per account | 50 / h |
| Sign-up per email | 5 / h |
| Reset per email | 3 / h |
| Refresh per IP | 600 / min |

**Projects** are owner-scoped: a foreign project returns 404. Each project's settings are bounded:

| Setting | Range |
|---|---|
| Access TTL | 60–3600 s |
| Idle timeout | 5 min – 30 days |
| Maximum session lifetime | 1 h – 90 days |

**Production refuses to start** without Redis, https, secure cookies or a real mailer.

**MCP tools:**
- 16 `auth_*` tools.
- A static reviewer with 20 rules, for example:
  - hard-coded secret keys
  - tokens in web storage
  - decoding JWTs without verifying them
  - client-supplied user ids
  - weakening RLS
  - leaking the data grant

**Tests:** 116 (server 78, SDK 24, MCP 14), plus two e2e scripts on real Postgres and Redis.

### Basalt API (`api/`, Appendix A)

`createApi()` is secure by default:
- auth is `required` unless a route says otherwise
- every request must carry the edge HMAC signature
- a response schema is mandatory (undeclared fields are stripped; a mismatch returns 500)
- the body schema is mandatory on POST, PUT and PATCH
- Location headers must be same-origin paths
- path patterns only, no regexes

Startup refuses unsafe route definitions: eight classes are tested.

**Status codes** are exact: 400, 401, 403, 404, 405, 409, 410, 412, 413, 415, 422, 429, 500, 503 and 504. Postgres errors map automatically:

| SQLSTATE | HTTP status |
|---|---|
| 23505 | 409 |
| 42501 | 403 |
| 28000 | 401 |
| 40001 | 503 |
| 57014 | 504 |

**Abuse limits (defaults):**

| Limit | Default |
|---|---|
| Per IP | 600 / min |
| Per user, per route | 120 / min |
| Public routes | 30 / min |
| Requests in flight | 512 (load shedding beyond that) |
| Timeout | 10 s |
| Body size | 100 KB |

Idempotency keys are kept for 24 h in Redis.

**`BASALT_API_CONFIG`** is agent-editable, strictly validated and bounded. It can only tighten auth. It covers limits, per-route overrides, a kill switch, maintenance mode and the log level.

**Tooling:** a dev edge, `basalt-migrate` (refuses SQL that weakens RLS; reports unprotected tables), 11 `api_*` MCP tools and a 10-rule reviewer.

**Tests:** 75 (framework 62, MCP 13), plus the plug-and-play e2e.

### Data block (`data/`, Appendix B)

**Schema.**
- One `SECURITY DEFINER` function is the only door. The Data service's login can execute only `basalt.api`, `file_put`, `file_link` and `file_fetch`.
- A contract (JSON) defines tables and fields. Field types:
  - text (with formats: email, phone, url, postal_code, slug)
  - integer, number
  - boolean, timestamp
  - user (another person)
  - file
- `required`, length and range limits are enforced both in TypeScript and as Postgres CHECKs.
- Migrations are additive only: adding a required field, changing a field's rules or changing sharing is refused.

**Who can see what.**
- Each person reaches only their own rows.
- `shareWith` grants read-only access to one user field.
- Admins (approved by the owner) see and change everything.
- There is no DELETE anywhere; rows are archived and restored instead.

**Damage limits.**
- Per user: 600 reads and 60 writes per minute, counted in the database. Failed attempts count too.
- `list` returns at most 100 rows.
- Data-role sessions: statement timeout 3 s, transaction timeout 5 s.

**Files.**
- Allowed types: PNG, JPEG, GIF, WebP, PDF, text and CSV, checked against magic bytes. SVG and HTML are refused.
- Up to 5 MB each, with a 50 MB quota per user.
- Download links last 5 minutes.

**Audit.** A month-partitioned audit log records column names only.

**Tests:** 104 (88 attack and feature tests, 16 file tests).

### Basalt Cloud (`cloud/`, Appendix B)

**Per app:**
- one Postgres database
- three roles
- an Auth project, so logins are real Basalt Auth logins

**Owner pages:**
- A plain-English approval page. Anything that shows data to more people waits for the owner's "Yes": first rules, sharing, admins.
- A data map: an SVG of where data lives, who can reach it, personal fields and live counts.
- A safety receipt.

**Guard** (`basalt_check` / `host_data_check`):
- It signs in as two real test people plus a stranger. It also uses a forged token and an expired re-signed token.
- It tries 11 or more attacks: reading, listing, filtering and changing someone else's rows, writing protected fields, and more.
- It counts errors as "couldn't tell", never as passed.
- A local code scan finds data kept outside Basalt, for example localStorage, other databases or data files.

**Platform API:** used by hosting to create, delete and set rules for environment data projects. It requires `CLOUD_PLATFORM_KEY` and is refused through the edge.

**Tests:** 51.

### Basalt Host (`hosting/`, Appendix C)

**Parts:** the control plane (Hono, a Postgres state database and the Docker Engine API over the socket), edge, egress, browser worker, a remote MCP at `/mcp`, and the local stdio MCP `@basalt/host-mcp`.

**Environments:**
- Previews: at most 3 per app, deleted after 24 h, asleep after 30 minutes idle.
- Staging sleeps when idle; production never sleeps.

**Containers:**
- non-root, read-only filesystem except `/tmp`, no capabilities, no new privileges
- limits on memory (256 MB, or 512 MB in production), CPU and processes
- outbound traffic only through the egress proxy

**CI:** `npm ci --ignore-scripts`, which stops supply-chain install scripts. Critical vulnerabilities and hardcoded secrets block the build.

**Edge:**
- Per-IP limits.
- Bans for exploit scanners, plus WAF-lite attack signatures.
- An optional proof-of-work browser challenge.
- Strict CSP with per-environment additions, and HSTS.
- Source maps and dotfiles are never served.

**Tests:** 52 unit and integration tests, plus the 47-check platform e2e.

---

## 6. Making Auth, Data, Cloud and Hosting one system

The Data block and Cloud were built in parallel with Auth. When they were combined:
- they had different token formats
- Cloud minted its own test tokens
- revocations didn't reach Data databases
- hosted apps had no Data block

The integration work (commits 22 and 23, finished in this pass) made them one system.

### The problems and how they were fixed

| Problem | Fix |
|---|---|
| Two token formats (Auth's `bdg1.` grants vs the Data block's JWTs) | Auth now mints the data grant as the HS256 JWT the Data block already verified. `GET /v1/platform/projects/:id/data-protection/signing` hands Cloud the per-project secret, issuer and max lifetime when it creates a Data database, so both in-database verifiers accept exactly one token. |
| Cloud test logins were self-minted | `AuthLink.testLogin` creates a real verified Auth user (`POST /v1/platform/projects/:id/users`) with a password derived from Cloud's master key. It signs in like a native app and returns the real `bdg`. Guard attacks with real sessions. |
| Revocations didn't reach Data databases | Auth's revocation feed, with `basalt.revoked_sessions`, `revocation_sync` and `record_revocations` added to the Data SQL. Cloud syncs every app every 10 s, now with bounded concurrency and no overlapping rounds. |
| Browsers needed a token in page code | Same-origin `/_basalt/data` on the app's own host. The Data service reads `bdg` from the HttpOnly session cookie, only for same-origin requests. `basalt()` needs no token. |
| Backends couldn't use the Data block | `ctx.data` in `@basalt/api` sends the user's grant as a Bearer token. `BASALT_DATA_URL` is provisioned per environment. |
| Hosted environments had no Data project | Control creates one per environment, bound to that environment's Auth project (`authProjectId`, `authOwner` = workspace, `externalId` = environment id, which makes retries safe). It deletes it on teardown by environment id. The admin key is stored encrypted. The edge routes `/_basalt/data`. |
| Rule changes were risky on production | Test environments take rules immediately through the platform API. Production goes through the owner's approval page whenever the rules show data to more people. |
| Two MCP tool sets (`basalt_*` vs `host_*`) | Hosted apps now get every data tool through the one hosting connector (§7). Cloud's `basalt_*` stdio connector stays for non-hosted apps. The local code scan is shared, and CI checks it stays in sync. |

---

## 7. The MCP connector

### Install

One connector per workspace. The operator runs `docker exec basalt-control node dist/admin.js create-workspace <name>`. It prints:

```sh
claude mcp add basalt -e BASALT_HOST_URL=<control URL> -e BASALT_HOST_TOKEN=bht_… \
  -e BASALT_ROOT_DOMAIN=<root> -e BASALT_REGISTRY_URL=<registry URL> \
  -- npx -y --registry <registry URL> @basalt/host-mcp
```

It also prints the same configuration as `.mcp.json`.

| Mode | Control URL | Registry URL |
|---|---|---|
| Production | `https://host.<root>` | `https://registry.<root>/` |
| Local demo | `http://127.0.0.1:4000` | `http://registry.basalt.localhost:8080/` |

The values come from `HOST_PUBLIC_URL` and `REGISTRY_PUBLIC_URL`. The control plane publishes `@basalt/host-mcp` (0.2.0), `@basalt/auth` and `@basalt/api` to its own Verdaccio on every start.

### How it works

- The local process (stdio) connects to `<control>/mcp` over Streamable HTTP with the workspace token.
- It lists remote tools plus three local ones. Remote calls get a 120 s timeout; Guard gets 180 s.
- Local tools act on the project folder:
  - `host_deploy` packs and uploads the project.
  - `host_init` writes `.npmrc`, `basalt.json`, the Playwright config and an example test, and never overwrites a file.
  - `host_data_check` scans the folder for data kept outside Basalt. The scan runs locally; only findings are sent. It then runs the remote Guard.
- Verified: a cold `npx` install from the platform registry connects in about 14 s, with an empty npm cache, and lists 54 tools.

### Tools (54)

| Group | Tools |
|---|---|
| Overview | `host_guide` (topics: workflow, project, **data**, testing, operations, security), `host_status`, `host_create_app` |
| Deploy | `host_init`\*, `host_deploy`\*, `host_deploy_source`, `host_wait`, `host_deployment`, `host_build_logs`, `host_promote`, `host_rollback`, `host_releases` |
| Observe | `host_logs`, `host_metrics` |
| Configure | `host_secrets`, `host_set_secret`, `host_delete_secret`, `host_api_config`, `host_update_api_config`, `host_route_policy`, `host_protection`, `host_csp` |
| Data (Data block, Cloud, Guard) | `host_data_rules`, **`host_data_status`**, **`host_data_admin`**, **`host_data_check`**\* |
| Test | `host_run_tests`, `host_test_user`, `host_test_emails`, `host_share_link` |
| Browser (real Chromium, preview and staging only) | `browser_open`, `browser_navigate`, `browser_click`, `browser_fill`, `browser_press`, `browser_select`, `browser_check`, `browser_hover`, `browser_wait_for`, `browser_snapshot`, `browser_screenshot`, `browser_console`, `browser_network`, `browser_evaluate`, `browser_close`, `browser_sessions` |
| Cleanup | `host_delete_env`, `host_delete_app` (both need `confirm: true`) |
| Auth and API toolkits | `auth_integration_guide`, `auth_security_rules`, `auth_review_code`, `api_integration_guide`, `api_security_rules`, `api_review_code` |

\* Local tools. `host_data_check` exists remotely too, and the local version adds the folder scan.

Tools new in this pass are bold.

The agent's workflow guide:
1. Create the app.
2. `host_init`.
3. Write the code using the API and Auth guides, plus the **data** guide for anything saved.
4. Run the reviewers.
5. `host_deploy`.
6. Debug with logs and the browser tools.
7. Verify on the preview.
8. **`host_data_check`**.
9. Stage.
10. Ship.
11. Report the URL.

### Standalone connectors

These are kept for use outside Basalt Host:

| Connector | Package | Tools | Purpose |
|---|---|---|---|
| Auth | `basalt-auth-mcp` (`auth/packages/mcp/dist/stdio.js`) | 16 | Run Auth projects directly |
| API | `basalt-api-mcp` | 11 `api_*` + 16 `auth_*` | Self-hosted apps with `LocalPlatform` |
| Cloud | `node cloud/src/mcp.ts` | 7 `basalt_*` | A Cloud database for apps not hosted on Basalt |

---

## 8. Deployment runbook

### Real server (the gaming laptop, or any Linux box with Docker)

1. **Install.** Docker Engine with Compose v2, `openssl`, and Node 24 (only if you run the e2e). Give Docker at least 8 GB; the defaults give builds and tests 1.5 GB each, with 2 at a time.
2. **Set up.** `cd hosting/deploy && ./setup.sh <root-domain> --tunnel <cloudflare-tunnel-token>`. This:
   - generates `.env`; back it up offline, since losing the master keys loses every encrypted secret
   - builds the runtime image and pulls the Playwright image
   - builds and starts everything with `--wait`
3. **Cloudflare.** Create the tunnel and route its public hostnames `<root>` and `*.<root>` to `http://edge:8080`. Cloudflare terminates TLS; the tunnel carries traffic to the edge from the inside, so no ports are published on the host.
4. **Optional mail.** Set `RESEND_API_KEY` (and `MAIL_FROM`) in `.env` to deliver production email. Test environments capture mail for `host_test_emails`.
5. **Workspaces.** `docker exec basalt-control node dist/admin.js create-workspace <name>` prints the connector setup for that user.
6. **Global attack switch.** `docker exec basalt-control node dist/admin.js under-attack on|off`. The edge applies it within about 3 s; this pass fixed it, before which it never applied.
7. **Upgrades.** `git pull && ./setup.sh <root-domain> --tunnel <token>` again. It is idempotent:
   - `.env` is kept, and new secrets are appended
   - images are rebuilt
   - Auth, control and Cloud run their migrations at boot
   - live releases keep running
8. **Backups.** Volumes `pgdata` (everything: platform state, Auth, every app and Data database), `redisdata`, `verdaccio` and `basalt-data` (sources, build workspaces, static files). Plus `.env`.

### One laptop (demo, no domain)

`./setup.sh basalt.localhost --local`. The local overlay:
- publishes the edge on `127.0.0.1:8080` and `[::1]:8080`
- publishes control on `127.0.0.1:4000`
- sets `PUBLIC_SCHEME=http` and `PUBLIC_PORT=8080` for control and edge, so links and allowed origins use the demo address
- caps builds and tests at 1 GB, one at a time

| What | Address |
|---|---|
| Apps | `http://<app>.basalt.localhost:8080` (previews: `<app>--<preview>`) |
| Owner pages | `http://cloud.basalt.localhost:8080` |
| Registry | `http://registry.basalt.localhost:8080` |

`*.localhost` resolves to loopback everywhere, and browsers treat it as a secure context, so Secure and `__Host-` cookies work over http.

### Environment variables added in this pass

All in control's config:

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_SCHEME` | `https` | Scheme of every URL shown to people and of Auth's allowed origins |
| `PUBLIC_PORT` | none | Port appended to those URLs (`8080` in the demo) |
| `HOST_PUBLIC_URL` | `https://host.<root>` | The connector's control URL, printed by `create-workspace` |
| `REGISTRY_PUBLIC_URL` | `https://registry.<root>/` | The `@basalt` registry for `npx` and `.npmrc` |
| edge `PUBLIC_SCHEME`, `PUBLIC_PORT` | `https`, none | What the plain listener reports to backends as `x-forwarded-proto` and `-host` |
| cloud `REVOCATION_SYNC_CONCURRENCY` | 4 | Apps synced in parallel |

### Verify a deployment

```sh
cd hosting && npm run build
BASALT_HOST_TOKEN=bht_… node scripts/e2e-platform.mjs     # 47 checks, about 3 minutes; E2E_KEEP=1 keeps the app
```

The e2e currently assumes the local overlay: edge on `127.0.0.1:8080`, control on `:4000`.

---

## 9. Security model

| Threat | Controls (layered) |
|---|---|
| App code leaks one user's data to another (forgotten `WHERE`, IDOR) | Forced RLS keyed to a signed per-session grant verified inside Postgres (`basalt_auth` for `ctx.sql`; `basalt.api` for the Data block). Owner columns default to the verified user and can't be set by clients. Guard attacks it before go-live. |
| Stolen or forged tokens | <ul><li>Ed25519 access tokens with `kid`, issuer and audience checks</li><li>HS256 grants checked for canonical encoding, lifetime and issuer</li><li>revocation sync within 10 s</li><li>refresh-token theft detection</li><li>HttpOnly cookies only; page JS can't read them (verified in a real browser)</li></ul> |
| CSRF | <ul><li>exact origin allow-lists, with JSON required on non-GET requests</li><li>SameSite cookies</li><li>Data cookie logins only accepted same-origin</li><li>the API refuses foreign-origin writes even on public routes</li></ul> |
| Credential stuffing and enumeration | Layered rate limits, identical responses, dummy hashing, decoy signup tokens, a hashing semaphore with 503 shedding |
| Direct access to backends | Backends live on per-environment internal networks and require the edge HMAC signature; unsigned requests get 403. Internals (`/_basalt/*`) are never public. |
| SSRF and lateral movement from app code | <ul><li>egress proxy only</li><li>private, link-local, metadata and LAN ranges blocked</li><li>web ports only</li><li>DNS rebinding handled</li><li>`ctx.fetch` is SSRF-safe as well</li></ul> |
| Supply chain | <ul><li>`npm ci --ignore-scripts` in a network sandbox that only reaches Verdaccio</li><li>`@basalt/*` never proxied from npmjs (dependency confusion)</li><li>audit and secret scanning gate the build</li></ul> |
| Container escape and abuse | Non-root, read-only filesystem, `cap_drop ALL`, `no-new-privileges`, memory, CPU and process limits, no Docker socket for apps |
| DDoS and abuse | <ul><li>Cloudflare in front</li><li>per-IP and per-app limits, per-app concurrency bulkheads, connection caps, slowloris timeouts</li><li>scanner bans, WAF-lite</li><li>proof-of-work under-attack mode (per app or global)</li></ul> |
| Unreviewed exposure of private data | Production rule changes that show data to more people need the owner's "Yes" on an approval page. Admins always need approval. |
| Private test environments leaking | Previews and staging need a signed access token or share-link cookie, get `noindex`, and are deleted after 24 h. |
| Browser tools as a pivot | The browser worker only opens platform hosts. All other traffic goes through egress. Loopback and metadata are refused (re-verified after this pass's proxy-flag change). |

---

## 10. Verification

### Test suites (all green on this branch)

| Suite | Command | Result |
|---|---|---|
| Auth server, SDK, MCP | `cd auth && npm test` | 78 + 24 + 14 = **116** |
| API framework, MCP | `cd api && npm run build && npm test` | 62 + 13 = **75** |
| Hosting | `cd hosting && npm test` | browser 3, control 16, edge 26, egress 3, mcp 4 = **52** (shared has none) |
| Data block (real Postgres 17) | `cd data && npm test` | **104** |
| Cloud + Guard (real Auth in-process) | `cd cloud && npm test` | **51** |
| Typecheck | `npm run typecheck` (auth, api, hosting) | clean |
| Scan drift | `node hosting/scripts/check-scan-sync.mjs` | matches |

### CI

| Workflow | Triggered by | Runs |
|---|---|---|
| `auth.yml` | auth | typecheck, test, build, plus integration e2e on compose |
| `api.yml` | api, auth SDK/MCP | build, typecheck, test, plus plug-and-play e2e |
| `hosting.yml` (new) | hosting, auth/api packages, Cloud scan | <ul><li>build, typecheck, test</li><li>scan-drift check</li><li>docker builds of control, edge and Cloud</li><li>`docker compose config` on both compose files</li><li>`bash -n setup.sh`</li></ul> |
| `data-cloud.yml` (new) | data, cloud, auth server | <ul><li>throwaway `.env` files</li><li>Data tests on a real Postgres</li><li>Auth build</li><li>Cloud tests</li></ul> |

### Platform e2e

`hosting/scripts/e2e-platform.mjs`, final run: **47/47 in 168 s**, followed by zero containers and zero databases left.

A simulated coding agent uses only the MCP connector (the real local stdio server), then the platform is probed from outside. Checks in order:

1. agent sees 54 tools (local + remote)
2. host_init prepared the project
3. host_deploy started a deployment
4. CI + preview pipeline passed (extract, security-scan, detect, lockfile, install, audit, typecheck, lint, unit-tests, build, package, static, image)
5. app e2e tests passed against the preview (2/2)
6. preview is private to the public (401, noindex)
7. share link grants a human access
8. browser_open shows the page snapshot
9. agent signed in and added a todo through the browser
10. browser_screenshot returns an image the agent can see
11. no server errors seen by the page
12. host_data_rules: preview rules go live right away
13. signed-in user saves through /_basalt/data with only the cookie (200)
14. each person only sees their own rows (enforced in Postgres)
15. another person can't read the row by id
16. another person can't change it
17. cross-site use of the cookie is refused (CSRF)
18. no login, no data
19. host_guide "data" explains the Data block
20. host_data_status: rules in plain English and the owner's data map link
21. the owner's data map opens through the edge
22. host_data_admin always asks the owner to approve
23. Guard: 11 of 11 attacks on the preview's data were refused
24. Guard: the local scan found data kept in browser storage
25. the owner's safety receipt opens
26. backend cannot reach cloud metadata
27. backend cannot reach the platform's internal services
28. backend can reach the public internet through the egress proxy
29. promoted to staging
30. staging tests passed
31. live in production at `http://<app>.basalt.localhost:8080`
32. production serves the app publicly with CSP and HSTS
33. production API requires sign-in
34. backend internals are not reachable publicly
35. scanner probes get nothing
36. production data rules wait for the human owner to approve
37. host_set_secret reached the running backend (zero-downtime restart)
38. secret values are never shown back
39. under-attack mode serves the proof-of-work challenge
40. release history recorded (2 releases)
41. instant rollback to the previous release
42. production still serving after rollback
43. metrics: requests counted, backend healthy
44. host_logs returns structured backend logs
45. production refuses deployments that have not passed staging
46. host_delete_app
47. no containers, databases or roles left behind

### Manual checks in this pass

**Connector as a user gets it.** Steps 1 to 3 below are what a user would do:
1. Ran `./setup.sh basalt.localhost --local` and waited for every service to be healthy.
2. Ran `create-workspace` and used exactly the printed `npx` command with an empty npm cache.
3. Result: connected in 13.7 s; 54 tools listed.
- Calls verified: `host_status`, `host_init` (wrote `@basalt:registry=http://registry.basalt.localhost:8080/`) and `host_guide project`.
- Then `npm install @basalt/api @basalt/auth` through the written `.npmrc` installed both with 0 vulnerabilities.

**Real Chromium on the demo stack.**
- The share link opened the private preview.
- Sign-in through the UI worked over http on `*.localhost`; Secure and `__Host-` cookies were accepted.
- Added a todo through the UI (backend `ctx.sql`).
- From page JS, with no token:

| Call | Result |
|---|---|
| `/_basalt/data/v1/data/create` | 200 |
| `list` | 1 row |
| Value over the 200-character limit | 400 `invalid_input` |
| `document.cookie` | No session cookie visible |

- Opened the production approval link from `host_data_rules`, read the plain-English rules and clicked "Yes, use these rules". `host_data_status` then reported the rules as live.

**Browser worker policy after the proxy change.** In a session on staging, navigating to each of these:

| Destination | Result |
|---|---|
| `http://127.0.0.1:7070` | "port 7070 is not allowed" |
| `http://localhost:7070` | "port 7070 is not allowed" |
| `http://169.254.169.254/` | "not a public internet destination" |
| `https://example.com` | Loaded |

---

## 11. Deployment-readiness pass (2026-10-24)

Goal: get the current state ready for deployment, put the finishing touches on each service, make sure they integrate, and get the MCP connector working.

### Bugs found by actually deploying and using it

Each bug was fixed and has a test.

1. **The registry was unusable from outside the platform** (production and demo).
   - **Symptom:** `npx @basalt/host-mcp` and `npm install @basalt/api` fetched metadata through the edge, but every tarball URL pointed at `http://verdaccio:4873/...`, an internal name.
   - **Cause:** Verdaccio builds absolute URLs from the `Host` header and ignores `X-Forwarded-Host`. The edge forwarded the upstream's own host.
   - **Fix:** service routes (registry, cloud, host) now receive the public host as `Host` (`edge/src/server.ts`). Tests in `edge.test.ts`: "platform services get the public host as Host…" and "behind Cloudflare… https on the default port".
2. **The connector printout was wrong outside production.** `create-workspace` hard-coded `https://host.<root>` and `https://registry.<root>/`, which don't exist in demo mode, and `host_init` and the project guide hard-coded the registry too.
   - **Fix:** `HOST_PUBLIC_URL` and `REGISTRY_PUBLIC_URL`, plus `BASALT_REGISTRY_URL` passed to the connector. `initProject` takes a full URL. It prints a `claude mcp add` one-liner and `.mcp.json`.
3. **Demo-mode browsers would be refused everywhere.** Every URL handed to people was `https://<host>`, and Auth allowed only that origin. The Data service compared the browser's `Origin` (`http://x.basalt.localhost:8080`) with `x-forwarded-host` (`x.basalt.localhost`). Real-browser sign-in and data calls in demo mode would have failed.
   - **Fix, in four parts:**
     - `PUBLIC_SCHEME` and `PUBLIC_PORT` in control (`appUrl()` for status, deploy logs, share links and allowed origins)
     - the same in the edge (`x-forwarded-host` and `-proto` for the plain listener; the TLS listener is always https)
     - Auth's `OriginSchema` accepts `http://*.localhost`, which is loopback by RFC 6761 (`settings.ts`, tested in `flows.test.ts`, with look-alikes like `localhost.evil.com` still refused)
     - Verified in real Chromium.
4. **In-platform tests and browser tools broke under `*.localhost`.** Chromium hard-wires `*.localhost` to its own loopback and ignores `/etc/hosts`:
   - The e2e runner's `extraHosts` mapping was ignored, giving `ERR_CONNECTION_REFUSED`.
   - In the browser worker, Playwright's proxy option appends `<-loopback>` last, which Chromium evaluates first, so platform hosts went to the egress proxy (`ERR_TUNNEL_CONNECTION_FAILED`).
   - **Fixes:**
     - The generated Playwright config adds `--host-resolver-rules=MAP <host> <edge IP>`.
     - The worker passes `--proxy-server` and `--proxy-bypass-list=<-loopback>;*.<root>;<root>` directly. Loopback is still proxied and blocked, which was verified.
5. **Cloud crashed when an app was deleted mid-sync.** Deleting a project runs `DROP DATABASE … WITH (FORCE)`, which ends every session. Standalone `pg.Client`s (revocation sync, rule application, stats) had no `'error'` listener, so the emitted error killed the whole Cloud process; it restarted, and the delete left an environment stuck in `deleting`. Found while deleting the demo app right after approving its production rules.
   - **Fix:** `connect()` attaches a listener. The failing query still rejects for its caller.
   - **Regression test:** `cloud.test.ts`, "a revocation sync caught mid-way…". It fails with `terminating connection due to administrator command` without the fix.
6. **`basalt-admin under-attack` never reached the edge.** The CLI is a separate process whose route-version bump is a no-op; the edge reloads only when the version changes.
   - **Fix:** control watches the setting every 3 s and syncs the edge on change.
7. **Wrong config defaults.** `BUILD_NETWORK` defaulted to `basalt-build`, but the network is named `basalt_build`. `INFRA_CONTAINERS` omitted `basalt-cloud`. Compose overrode both; the defaults now match.
8. **The control healthcheck used the internal path.** It is now `/v1/health` on the public port; the first `setup.sh` run caught this.
9. **File fields read "undefined"** on approval pages and in status text. `describeField` now covers `file`, with a test.

### Finishing touches

- **One connector covers data:**
  - `host_data_status` (rules in plain English, plus the owner's data map link)
  - `host_data_admin` (always an approval link)
  - `host_data_check` (Guard + local scan; remote and local versions)
  - the `data` guide topic: rules format, the browser `basalt()` client for `/_basalt/data` including uploads and file links, `ctx.data`, error codes
  - workflow and server instructions updated
  - connector version 0.2.0
  - the scan was extended with a `bht_` workspace-token rule
- **Startup is gated on health.** Healthchecks for cloud, control and edge. `depends_on` uses `service_healthy` from postgres and redis through auth, cloud and control to the edge. `setup.sh` uses `up --wait --wait-timeout 300`, prints the Cloudflare hostname mapping and the connector step.
- **Demo-mode networking.** Local overlay: IPv6 loopback publish (`[::1]:8080`, since `*.localhost` resolves to `::1` first), `PUBLIC_SCHEME` and `PUBLIC_PORT` for control and edge, `HOST_PUBLIC_URL` and `REGISTRY_PUBLIC_URL`.
- **Cloud revocation sync scales.** It runs with bounded concurrency (`REVOCATION_SYNC_CONCURRENCY`, default 4) and skips a round while one is running, so a slow Auth or many apps can't stack rounds or open every database at once.
- **CI.** New `hosting.yml` and `data-cloud.yml` workflows, plus `hosting/scripts/check-scan-sync.mjs`.
- **e2e.** Covers `host_guide data`, `host_data_status`, the data map, `host_data_admin`, Guard with a planted localStorage finding, and the receipt. It uses demo-mode origins. `E2E_KEEP=1` keeps the app for manual checks.
- **Docs:**
  - root README: connector section, real-server tunnel step, updated open items
  - Cloud README: which connector to use when
  - Auth README: current data-grant format and origin rule
  - Data README: test count
  - this document

---

## 11b. Rules as code, Guard as a deploy gate, unique fields (PR #3 → PR #5)

Mihir's PR #3 branched before PR #4 merged. It conflicted with main in 12 files. PR #5 merges it onto main (his commits are kept), keeps his features, takes main's version wherever both solved the same problem, and fixes the bugs the merge exposed.

### Kept from PR #3

- **`basalt.data.json` (rules as code).**
  - The build reads the app's data rules (up to 256 KB of JSON).
  - Every preview and staging deploy applies them before the release and its tests. If Cloud refuses them, the deploy fails with Cloud's reason.
  - Shipping or promoting to production applies them first. When they need the owner's approval, it stops with the approval link and releases nothing. After the owner says yes, promoting again goes live.
- **Guard as a deploy gate.**
  - For apps with `basalt.data.json`, Guard runs after the e2e tests on every preview and staging deploy. It is recorded as a `guard` test run.
  - Any check that gets through fails the deploy.
  - Promoting to production requires a passed Guard run in staging.
- **`unique` in the Data block.**
  - Up to 5 groups of 1 to 3 required fields per table, enforced by partial unique indexes over active rows only. Archiving frees the value.
  - A clash returns `conflict` (HTTP 409), naming the fields but never whose row holds them.
  - It can only be set when a table is created; migrations refuse to change it.
  - Guard generates fresh values for unique fields.
  - Owner pages describe it in plain words.
  - Tests: 5 in `data/test/unique.test.ts`, plus one for the summary text.
- **Production sign-up emails readable in demo mode.** Production email is readable by the agent only on the one-laptop demo (`PUBLIC_SCHEME=http`) with no email provider configured. Otherwise a demo sign-up could never be finished. Real deployments keep production email private.
- **`host_init` serves a plain `public/` site as is** when there is no build script.
- **The workflow guide tells agents not to run `npm install` on the human's computer.**
- **`setup.sh` downloads the 3.5 GB test-browser image in parallel** with the build.
- **The Data service compares the cookie origin by hostname.** Compatible with main's port-aware edge, and covered by a test.
- **`hosting/scripts/e2e-salon.mjs`:**
  - a salon app with no backend that signs in with Basalt Auth and books through `/_basalt/data`
  - two customers kept apart on preview and on production
  - the owner approving production rules
  - real sign-ups verifying their emails

### Superseded by main (dropped)

- `LOCAL_HTTP_PORT`, `appUrl()` and `appOrigins()`: main's `PUBLIC_SCHEME` and `PUBLIC_PORT` (`cfg.appUrl()`) already cover links, Auth origins and the edge.
- Auth `*.localhost` origins: identical in main.
- `BASALT_HOST_RULES` in the e2e runner: main already maps the host. The automatic merge produced two `launchOptions` keys in the generated Playwright config, which is invalid; main's copy is the one kept.
- `EGRESS_PROXY: ""` for the browser worker in demo mode: dropped. It would have let pages opened by the agent's browser tools reach internal services directly. Main fixes the same Chrome problem with the proxy still on, and that was verified.

### Fixed while merging

1. **Hidden type clash.** `data-link.ts` merged "cleanly" with two different `GuardResult` interfaces and two Guard calls (`runGuard`, `runDataCheck`). Now there is one `runDataCheck`, returning both `results` and `failures`.
2. **Duplicate `host_data_check` tool and `Host.dataCheck`.** Registering a tool twice would fail the MCP server at startup. There is now one tool and one method. It has main's local folder scan and PR #3's refusal to run on production, where Guard's test people and rows don't belong among real customers. It records a `guard` test run, so on-demand checks count toward the production gate.
3. **Broken file links in the data guide.** `fileUrl` called `/_basalt/data/v1/data/files/link`, which the edge 404s; the real route is `/v1/files/link`. A new test checks every Data path in the guide against the edge's allow-list.
4. **Privacy warning.** A `conflict` tells whoever tried that a value is taken. The guide now says not to make personal details (email, phone, name) unique. Unique is for slots, seats and order numbers.
5. **Data guide merged.** Mihir's fuller guide is kept. It now also covers `host_data_status`, `host_data_admin`, `host_data_rules` and the local scan in `host_data_check`.

### Verification

| Check | Result |
|---|---|
| Auth tests | 116 |
| Data tests | 110 (5 new uniqueness tests, 1 new port test) |
| Cloud tests | 52 |
| Hosting tests | 62 |
| Hosting typecheck | clean |
| Platform e2e (`e2e-platform.mjs`) on the rebuilt demo stack | 47/47 in 149 s |
| Salon e2e (`e2e-salon.mjs`) | 25/25 |
| Leftovers after both runs | none |



### Deployment

- Nothing has run behind a real domain and Cloudflare Tunnel yet. The tunnel path is configured (`cloudflared` on `10.200.0.250`, edge `TRUSTED_PROXIES`) and the hostname mapping is documented, but it is unexercised.
- `RESEND_API_KEY` must be set for production email delivery. Without it, production sign-up codes are only logged as not delivered.
- One machine is a single point of failure. Back up `pgdata` and `.env`.
- The e2e assumes the local overlay's published ports.

### Auth

- The data-key version is fixed at 1. Rotating the data key has no API.
- Mail is sent fire-and-forget. A failed webhook drops that email; the user can ask to resend.

### Data block and Cloud

These come from Appendix B §7 and are still open:
- The Data verifier `basalt.uid()` ignores `kid`. There is one secret per database, so key rotation needs a planned migration.
- `basalt.settings.max_token_seconds` isn't synced from Auth (both are 3600 today).
- `cloud.projects.jwt_secret` is written but never read.
- `Projects.delete()` doesn't delete the Auth project for standalone Cloud apps. Hosting deletes its own Auth projects.
- A failed create can leave cluster-wide roles behind.
- `maxProjects` and the per-IP creation limit are in-memory and per instance.
- Approval links have no time-based expiry, and pending admin approvals aren't superseded.
- File download tickets are reusable until their 5-minute expiry.
- There is no route to remove an admin.
- The standalone `basalt_*` MCP's `.gitignore` check accepts one spelling of `.basalt/`.
- The Data server's cookie path trusts `X-Forwarded-Host` without a trust-proxy switch. On the platform only the edge can reach it, and the edge sets that header.

### Hosting

- The edge's internal TLS certificate is self-signed; it is used only inside the platform.
- Verdaccio's npmjs uplink is the only path to public packages. If npmjs is down, installs of uncached packages fail.
- Each environment's backend is a single container, with zero-downtime switchover but no horizontal scaling. Capacity is bounded by `MAX_RUNNING_APPS` (40).

### Product

The demo story is plain vibe-coded apps versus Basalt apps. A first test found that plain builds got basic per-customer checks right. The pitch is that nothing guarantees that, and later edits can quietly break it, while Basalt's rules sit below the code.

---

## 11c. The owner's dashboard, the IP allowlist, and the one-command start (2026-10-24)

Goal: a graphical, non-technical dashboard for the owner of apps hosted on Basalt — analytics, logs, incidents, deployments and security — plus a way to always-allow the owner's own address so a security test (an attack harness run from the same computer) isn't blocked, and a single command that starts everything and hands the coding agent its connector file.

### The IP allowlist (edge)

- **`AppRoute.allowIps`** (`hosting/packages/shared/src/routes.ts`): client IP buckets the app's workspace always lets through. The route table fills it per workspace from a new `allowlist` table (`003_allowlist.sql`, `workspace_id + ip`), so one owner's allowlist only covers that owner's apps.
- **Edge pipeline (`edge/src/server.ts`)**: the route is looked up first, and an allowlisted client skips the ban check, the per-IP concurrency cap, both rate-limit buckets and every shield penalty. The WAF still inspects and **refuses each malicious request** (`attack_signature` → 403, `scanner_path` → 404), and every refusal is still recorded — the protection stays real and visible, it just never adds up to a ban for that address. Verified: an allowlisted IP sent 16 attack probes in a row, each refused, `bans` stayed empty, and it still loaded the site (200).
- **Ban provenance (`edge/src/shield.ts`)**: a ban now records when it started, why (the last-straw reason) and on which host, so the dashboard can explain each block in plain words.
- **Edge analytics (`edge/src/metrics.ts`)**: 24 h of per-minute traffic, unique visitors per hour, top pages and features (ids collapsed, e.g. `/api/todos/:id`), devices, browsers, referrers, a recent-visit log (query strings dropped — they can hold tokens) and a bounded security-event feed. New admin endpoints `GET /detail?host=` and `GET /security?hosts=` next to the existing `/metrics` and `/bans`.

### The dashboard (control)

- **`control/src/dashboard.ts`** serves `/dashboard` off the control plane (reachable at `host.<root>`, and directly on `127.0.0.1:4000` in the demo — so even a banned laptop can still open it and allow itself).
  - The owner signs in from a signed link (`dashboardLink`, 24 h), which sets a 12 h HttpOnly session cookie scoped to `/dashboard`. No agent token involved.
  - `GET /api/state` returns, for the owner's workspace only: every app and environment with status and 24 h sparkline; the selected environment's traffic detail, releases, backend health and data rules; recent deployments with CI steps, pipeline logs and test runs; **incidents** derived server-side (outages, error spikes via `errorSpikes`, automatic rollbacks, failed deploys, Guard findings, active bans); the security feed, bans and allowlist; the viewer's own IP; and the change history.
  - Writes are same-origin only (a custom header + JSON content type + origin check): `POST/DELETE /api/allowlist`, `POST /api/unban` (only lifts bans that touch the owner's apps), `GET /api/logs` (parsed backend logs), and `POST /api/connector` (a fresh workspace token as a downloadable `.mcp.json`).
- **The page** (`control/src/dashboard-ui/`, inlined under a strict per-nonce CSP; `style-src-attr 'unsafe-inline'` is the one scoped allowance, for dynamic widths): plain dependency-free HTML/CSS/JS. Seven sections — Overview (a plain-English verdict + KPIs + traffic), Visitors, Speed & errors, Security, Updates, Problems, Activity log — hand-drawn SVG charts with hover, light/dark themes, a phone layout, and a **right-click menu on any IP** to always-allow, unblock, filter or copy it. The blocked-visitors table and the "This computer" card make the allowlist one click. The whole thing polls `/api/state` every 5 s.
- **`host_dashboard`** MCP tool and `basalt-admin dashboard-link <ws> [--connect]` both hand over a link. `basalt-admin tokens`/`revoke-token` manage connector keys.

### One-command start and the connector download

- **`start.sh`** (with `start-mac.command` and `start-windows.cmd`): checks Docker (and WSL on Windows), builds and starts the stack via `setup.sh … --local`, ensures a `my-apps` workspace, and opens the **Connect Claude** page (`/dashboard/connect`). `--no-build` restarts in ~45 s; `--stop` stops the platform and keeps apps and data. `.gitattributes` keeps the shell scripts LF in a Windows checkout.
- **Connect Claude page**: picks the OS, downloads a ready `.mcp.json` (each download mints its own key), and shows a copy-paste command to drop it in an app folder as `.mcp.json` and open Claude Code. Windows gets `cmd /c npx` and the loopback registry (`REGISTRY_LOOPBACK_URL`, published on `127.0.0.1:4873`) because Node on Windows can't resolve `*.localhost`. `connector.ts` is the single source for the file; the admin CLI and the download use it.

### Verification

- Hosting tests: **70** (edge 29 incl. 3 new allowlist/analytics tests, control 30 incl. 5 new connector/dashboard tests, egress 3, browser 3, mcp 5). Build and typecheck clean.
- On the running demo stack: deployed a static app, drove real traffic and a batch of attack probes, then exercised the dashboard in a real Chromium — every section rendered with no JS or CSP errors in light and dark mode, the cold-installed connector connected in ~8 s and listed 55 tools, the connector download produced a working file (Mac and Windows shapes), the registry served working tarballs on loopback and refused anonymous publish, and the allowlist round trip (add → ban lifted → re-attack stays unbanned → site still loads) worked end to end.

### Still open

- The dashboard reads the edge's in-memory analytics, so a platform restart resets the 24 h history (bans and allowlist persist; the latter is in Postgres).
- `start-windows.cmd` and the Windows connector are written but unexercised on a real Windows machine.

---

## Appendix A: Basalt Auth and Basalt API

Exhaustive inventory, checked against the code. Facts changed by the readiness pass (§11) are marked in place.

Source: `/Users/Hari/basalt` @ branch `hari` (HEAD 569a411). Paths repo-relative. Verified against source; README claims noted only where code agrees.

---

### PART 1 — Basalt Auth (`auth/`)

#### 1.1 Purpose / layout

- Hosted email+password auth service for Basalt apps: sign-up w/ emailed code, sign-in, sessions (JWT + rotating refresh), password reset/change, TOTP MFA + recovery codes, session mgmt, admin API, audit log, step-up re-auth, and "data grants" (DB-enforced row ownership in the app's own Postgres via RLS).
- npm workspaces root `auth/package.json` (`basalt-auth`, private, node `>=24.7.0`, scripts `build`/`typecheck`/`test` across workspaces).

| Package | Name | Role |
|---|---|---|
| `auth/packages/server` | `@basalt/auth-server` 0.1.0 (private; bin `basalt-auth-server`) | Hono + Postgres + Redis service |
| `auth/packages/sdk` | `@basalt/auth` 0.1.0 (exports `./client`, `./server`, `./react`; dep `jose`; optional peer `react>=18`) | browser client, backend verifier, React bindings |
| `auth/packages/mcp` | `@basalt/auth-mcp` 0.1.0 (bin `basalt-auth-mcp`; deps `@modelcontextprotocol/sdk`, `zod`) | MCP tools for coding agents |
| `auth/scripts/e2e.mjs` | — | E2E vs docker compose (real PG+Redis) |
| `auth/scripts/e2e-data.mjs` | — | E2E data-protection on real Postgres with restricted login role |

Server deps: `@hono/node-server ^2.1.5`, `hono ^4.13.13`, `ioredis ^6.0.0`, `jose ^6.2.13`, `pg ^8.23.1`, `zod ^4.6.7`. Dev: `@electric-sql/pglite ^0.5.11` (tests use real PG in WASM), `typescript ^7.0.2`, `vitest ^4.1.12`.
Server scripts: `build` = `tsc -p tsconfig.build.json && cp -R src/db/migrations dist/db/`; `dev` = `node --env-file-if-exists=.env --experimental-strip-types src/main.ts`; `start` = `node dist/main.js`; `migrate` = `node dist/migrate-cli.js`.

#### 1.2 Server files (`auth/packages/server/src`)

| File | What it does |
|---|---|
| `index.ts` | Library exports: createApp/createServices, bootstrap, loadConfig, createPgDb, migrate, KeyRing, AuthError/ErrorCodes, ConsoleMailer/WebhookMailer, PasswordHasher/HibpBreachChecker/DEFAULT_ARGON2, Memory/RedisRateLimiter, Semaphore, ProjectSettingsSchema |
| `main.ts` | Entrypoint: sets `UV_THREADPOOL_SIZE ??= max(8, availableParallelism())` before imports; `bootstrap()`; `serve` on `config.port`; SIGTERM/SIGINT → `server.close` → `shutdown()` → exit 0; hard exit(1) after 15 s |
| `migrate-cli.ts` | Runs `migrate()` with `DATABASE_URL`, pool max 1 |
| `bootstrap.ts` | Loads config, creates pg pool, runs migrations, Redis (`maxRetriesPerRequest:2, enableAutoPipelining`), builds `ServiceContext`, services, app; readiness = `SELECT 1` + `redis.ping()`; maintenance every 5 min (`MAINTENANCE_INTERVAL_MS`, unref'd); `shutdown()` = clear timer, `accounts.drain()`, `db.close()`, `redis.quit()`. Console mailer gets logger with `allowKeys:['text']` |
| `config.ts` | zod env schema + production refusals (see 1.9) |
| `context.ts` | `ServiceContext` {db, keyRing, hasher, rateLimiter, mailer, breachChecker, log, publicUrl, now}; `RequestMeta` {ip, ipKey, userAgent} |
| `settings.ts` | `ProjectSettingsSchema` (bounded per-project knobs), `ProjectSettingsPatchSchema`, `OriginSchema`/`OriginListSchema` (max 50) |
| `http.ts` | Cookie names, IP extraction/normalization, IPv6 /64 bucketing, browser vs native mode, cookie setting/clearing, token readers, JSON body reader |
| `app.ts` | Hono app: global headers, 16 KiB body limit, error mapping, health, platform control plane, per-project API, secret-key admin API |
| `data-protection-sql.ts` | `DATA_PROTECTION_SQL_TEMPLATE` installed into app DB (`basalt_auth` schema) + `renderDataProtectionSql()` |
| `db/db.ts` | `Db` interface (`query`, `transaction`, `close`); `createPgDb` pg.Pool (max default 20, idle 30 s, connect timeout 5 s, `statement_timeout` 5 000 ms, `application_name: basalt-auth`) |
| `db/migrate.ts` | Applies `migrations/*.sql` sorted, in one tx, under `pg_advisory_xact_lock(727455001)`; tracks in `auth_schema_migrations` |
| `db/migrations/001_init.sql` | Initial schema |
| `db/migrations/002_data_protection.sql` | Data key columns, `authenticated_at`, revocation feed table + trigger |
| `lib/crypto.ts` | `randomToken`, `randomId`, `randomNumericCode` (crypto.randomInt), `sha256`, `hmacSha256`, `constantTimeEqual`, `uuidv7`, `KeyRing` |
| `lib/password.ts` | Argon2id `PasswordHasher`, `assertAcceptablePassword`, `HibpBreachChecker` |
| `lib/common-passwords.ts` | `COMMON_PASSWORDS` set (~200 entries, all ≥10 chars) |
| `lib/totp.ts` | RFC 6238 TOTP, base32, otpauth URL |
| `lib/ratelimit.ts` | Sliding-window-approx limiter: `MemoryRateLimiter`, `RedisRateLimiter` (Lua) |
| `lib/semaphore.ts` | Bounded concurrency + bounded queue; full queue → `server_busy` 503, Retry-After 2 |
| `lib/email.ts` | `normalizeEmail`: trim+NFC display, max 254, regex; normalized = NFKC + lowercase |
| `lib/errors.ts` | `ErrorCodes` → HTTP status map; `AuthError(code, message, {retryAfterSeconds, details})` |
| `lib/logger.ts` | JSON logs; redacts keys matching `/pass(word)?\|secret\|token\|code\|authorization\|cookie\|key/i`; warn/error → stderr |
| `lib/mailer.ts` | Templates + `ConsoleMailer` (outbox capped 1000) + `WebhookMailer` (signed POST, 5 s timeout) |
| `services/projects.ts` | Project CRUD, secret key gen/rotate/verify, 15 s cache (max 10 000 entries) |
| `services/signing-keys.ts` | Ed25519 key store, JWKS, access-token signing, rotation/retirement |
| `services/sessions.ts` | Session create/refresh/revoke, refresh token format, reuse detection, `issueAccess`, `markAuthenticated` |
| `services/accounts.ts` | Sign-up/verify/resend, sign-in/MFA, reset, verify email, change password, reauth, TOTP enroll/confirm/disable, recovery codes, delete account |
| `services/admin.ts` | Users list/get/update/delete/revoke, events list, platform `createVerifiedUser` |
| `services/data-grants.ts` | Data-token mint (HS256), signing config, install SQL, revocation feed |
| `services/audit.ts` | `audit()` insert into `auth_events`; `AuditEventType` union |
| `services/users.ts` | `UserRow`, `PublicUser`, `toPublicUser` |
| `services/limits.ts` | `LIMITS` + code/MFA constants |
| `services/maintenance.ts` | Batched cleanup under `pg_try_advisory_xact_lock(727455002)` |

#### 1.3 HTTP routes (server `auth/packages/server/src/app.ts`)

Global: every response gets `Cache-Control: no-store` (unless set), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Cross-Origin-Resource-Policy: same-site`; if `cookieSecure` also `Strict-Transport-Security: max-age=63072000; includeSubDomains`. Body limit 16 KiB → 413 `payload_too_large`. Errors `{error:{code,message,details?}}`; ZodError → 400 `invalid_request` with `details[{path,message}]`; unknown → 500 `internal_error`; 404 `not_found`. `Retry-After` set when `retryAfterSeconds`.

##### Infra
| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/healthz` | none | 200 `{ok:true}` |
| GET | `/readyz` | none | 200 `{ok:true}` / 503 `{ok:false}` (DB `SELECT 1` + Redis ping) |

##### Control plane `/v1/platform` (Bearer platform key, compared as SHA-256 digests w/ `timingSafeEqual`; header `X-Basalt-Owner` required, regex `^[A-Za-z0-9_.:-]{1,200}$`; foreign projects → 404)
| Method | Path | Does | Status |
|---|---|---|---|
| GET | `/projects` | list owner's projects (LIMIT 500) | 200 |
| POST | `/projects` | create `{name 1-100, allowedOrigins?, settings?}` strict; returns `{project, secretKey}` | 201 |
| GET | `/projects/:id` | get | 200/404 |
| PATCH | `/projects/:id` | update name/allowedOrigins/settings (partial, strict; settings merged + re-validated) | 200 |
| DELETE | `/projects/:id` | delete (cascades) | 204 |
| POST | `/projects/:id/rotate-secret-key` | new `bslt_sk_` key; old invalid immediately | 200 `{secretKey}` |
| POST | `/projects/:id/rotate-signing-key` | new Ed25519 active key; old → retiring | 200 `{kid}` |
| GET | `/projects/:id/data-protection/install.sql` | rendered install SQL (contains key), `content-type: application/sql; charset=utf-8` | 200 |
| GET | `/projects/:id/data-protection/signing` | `{algorithm:'HS256', keyVersion, secret, issuer, maxTokenSeconds:3600}` (for Data block) | 200 |
| GET | `/projects/:id/data-protection/revocations?since=&cursor=` | revocation feed | 200 / 400 bad since/cursor |
| POST | `/projects/:id/users` | `createVerifiedUser {email,password}` (policy w/o breach check) | 201 / 409 `email_taken` |
| GET | `/projects/:id/users?limit=&cursor=&email=` | list (limit 1–200, default 50) | 200 |
| GET | `/projects/:id/users/:userId` | get | 200/404 |
| PATCH | `/projects/:id/users/:userId` | `{metadata?, disabled?}` strict | 200 / 413 metadata >16 KB |
| DELETE | `/projects/:id/users/:userId` | delete | 204 |
| POST | `/projects/:id/users/:userId/revoke-sessions` | revoke all | 200 `{revoked}` |
| GET | `/projects/:id/events?userId=&limit=&before=` | audit events (id DESC) | 200 / 400 bad userId |

Bad/missing platform key → 401 `unauthenticated`; missing owner → 400.

##### Per-project API `/v1/projects/:projectId` (browser path `/_basalt/auth`)
Middleware: project lookup (id regex `^prj_[A-Za-z0-9]{8,40}$`, else 404); CORS exact allow-list only: OPTIONS from non-allowed origin → 403, allowed → 204 with `ACAO=<origin>`, `ACAC: true`, methods `GET, POST, PATCH, DELETE`, headers `content-type, authorization`, `Max-Age: 600`, `Vary: Origin`. Non-OPTIONS responses add `Vary: Origin` + ACAO/ACAC if allowed.

"clientMode": Origin present → must be in `allowedOrigins` else 403 `origin_not_allowed` → mode `browser` (cookies only); no Origin → `native` (tokens in body) unless `allowBearerTokens=false` → 403 `forbidden`.
"principal": access token from `Authorization: Bearer` first; else cookie (non-GET/HEAD requires valid clientMode; GET with foreign Origin → no token); JWT verified (EdDSA, `typ at+jwt`, issuer, aud=projectId; JWKS cache 30 s) AND live session row (`revoked_at IS NULL`, not expired/idle-expired, user matches) → else 401.

| Method | Path | Auth | Does | Status |
|---|---|---|---|---|
| GET | `/.well-known/jwks.json` | none | public JWKS (active+retiring), `Cache-Control: public, max-age=300, stale-while-revalidate=60`, `ACAO: *` | 200 |
| GET | `/config` | none | `{appName, requireEmailVerification, passwordMinLength, allowTotp}` | 200 |
| POST | `/signup` | clientMode | `{email,password}`; verification on → `{status:'verification_required', signupToken}`; off → session | 202 / 201 / 400 weak/breached / 409 email_taken (verif off) / 429 |
| POST | `/signup/verify` | clientMode | `{signupToken, code}` → creates user, session | 201 / 400 invalid_code / 409 / 429 too_many_attempts |
| POST | `/signup/resend` | clientMode | `{signupToken}` new code (silent for unknown/decoy) | 202 `{status:'sent'}` |
| POST | `/signin` | clientMode | `{email,password}` → session or `{status:'mfa_required', mfaToken, mfaTokenExpiresAt}` | 200 / 401 invalid_credentials / 403 account_disabled / 403 email_not_verified (sends code) / 429 |
| POST | `/signin/mfa` | clientMode | `{mfaToken, code}` (TOTP or recovery) | 200 / 400 invalid_code / 401 invalid_token / 429 |
| POST | `/email/verify` | clientMode | `{email, code}` → session, or `{status:'email_verified', user}` if MFA enabled | 200 |
| POST | `/email/verification/send` | principal | send verify code (no-op if verified) | 202 |
| POST | `/password/reset/request` | clientMode | `{email}`; work in background; identical response | 202 `{status:'sent'}` |
| POST | `/password/reset/confirm` | clientMode | `{email, code, newPassword}`; revokes all sessions; no auto sign-in | 200 `{status:'password_reset'}` |
| POST | `/session/refresh` | clientMode | browser: refresh cookie only; native: body `refreshToken`; per-IP limit; invalid → clears cookies (browser) | 200 / 401 invalid_token / 409 refresh_in_progress / 429 |
| POST | `/session/signout` | clientMode | revoke by refresh token, else by principal; idempotent; clears cookies | 200 `{status:'signed_out'}` |
| GET | `/session` | principal | `{user, session:{id, accessTokenExpiresAt}}` | 200/401 |
| GET | `/sessions` | principal | active sessions (≤100, `current` flag) | 200 |
| DELETE | `/sessions/:sessionId` | principal | revoke own session (id regex `^[0-9a-f-]{36}$`) | 200 `{status:'revoked'}` / 404 |
| POST | `/sessions/revoke-others` | principal | revoke all except current | 200 `{revoked}` |
| POST | `/session/reauthenticate` | principal | `{password, code?}` step-up; new access token only (refresh cookie untouched) | 200 / 401 mfa_required / 401 invalid_credentials / 400 invalid_code |
| POST | `/password/change` | principal | `{currentPassword, newPassword}`; revokes other sessions | 200 `{status:'password_changed'}` |
| POST | `/mfa/totp/enroll` | principal | `{secret (base32), otpauthUrl}` | 200 / 403 forbidden (allowTotp=false) / 409 conflict |
| POST | `/mfa/totp/confirm` | principal | `{code}` → `{recoveryCodes[10]}` | 200 / 400 |
| POST | `/mfa/totp/disable` | principal | `{password, code}` | 200 `{status:'disabled'}` |
| POST | `/mfa/recovery-codes` | principal | `{code}` (TOTP only) → new recovery codes | 200 |
| POST | `/account/delete` | principal | `{password}`; clears cookies if Origin | 200 `{status:'deleted'}` |

##### Secret-key API `/v1/projects/:projectId/admin` (Bearer `bslt_sk_…`; ANY `Origin` header → 403 `forbidden`; bad key → 401)
| Method | Path | Does | Status |
|---|---|---|---|
| GET | `/users?limit=&cursor=&email=` | list (keyset cursor on `(created_at,id)`, base64url JSON) | 200 |
| GET | `/users/:userId` | get | 200/404 |
| PATCH | `/users/:userId` | metadata/disabled | 200 |
| DELETE | `/users/:userId` | delete | 204 |
| POST | `/users/:userId/revoke-sessions` | revoke all | 200 |
| GET | `/events?userId=&limit=&before=` | audit log | 200 |
| GET | `/revocations?since=&cursor=` | revocation feed (used by SDK `syncRevocations`) | 200 |
| POST | `/sessions/verify` | `{accessToken}` → `{active:false}` or `{active:true, user, session:{id, amr}}` | 200 |

##### Error codes (`lib/errors.ts`)
400: invalid_request, weak_password, breached_password, invalid_code, code_expired · 401: invalid_credentials, unauthenticated, invalid_token, mfa_required · 403: reauthentication_required, email_not_verified, forbidden, origin_not_allowed, account_disabled · 404 not_found · 409: email_taken, conflict, refresh_in_progress · 413 payload_too_large · 429: too_many_attempts, rate_limited · 500 internal_error · 503 server_busy. (SDK adds client-only `network_error`.)

#### 1.4 Database schema (auth DB)

Migration runner: `auth_schema_migrations(name text PK, applied_at timestamptz default now())`, created by `db/migrate.ts`; advisory xact lock `727455001`. Migrations run at boot.

##### `001_init.sql`
| Table | Columns | Indexes / constraints |
|---|---|---|
| `auth_projects` | id text PK, owner_id text (len 1–200), name text (len 1–100), secret_key_hash bytea, secret_key_hint text, allowed_origins text[] default '{}', settings jsonb default '{}', created_at, updated_at | `auth_projects_secret_key_hash_idx` UNIQUE(secret_key_hash); `auth_projects_owner_idx`(owner_id, created_at) |
| `auth_signing_keys` | kid text PK, project_id → projects CASCADE, public_jwk jsonb, private_key_enc bytea, status CHECK in ('active','retiring','retired'), created_at, retired_at | `auth_signing_keys_one_active_idx` UNIQUE(project_id) WHERE status='active'; `auth_signing_keys_project_idx`(project_id, status) |
| `auth_users` | id uuid PK, project_id → CASCADE, email, email_normalized, email_verified_at, password_hash, password_changed_at, totp_secret_enc bytea, totp_enabled_at, totp_last_step bigint, metadata jsonb default '{}', disabled_at, last_sign_in_at, created_at, updated_at | UNIQUE(project_id, email_normalized); `auth_users_project_created_idx`(project_id, created_at, id) |
| `auth_pending_signups` | id uuid PK, project_id → CASCADE, email, email_normalized, password_hash, signup_token_hash bytea UNIQUE, code_hash bytea, attempts int default 0, expires_at, created_at | `auth_pending_signups_email_idx`(project_id, email_normalized); `auth_pending_signups_expires_idx`(expires_at) |
| `auth_email_codes` | id uuid PK, project_id, user_id → users CASCADE, purpose CHECK in ('reset_password','verify_email'), code_hash, attempts, expires_at, consumed_at, created_at | `auth_email_codes_user_idx`(user_id, purpose) WHERE consumed_at IS NULL; `auth_email_codes_expires_idx` |
| `auth_sessions` | id uuid PK, project_id, user_id → CASCADE, amr text[], ip, user_agent, created_at, last_active_at, idle_expires_at, expires_at, revoked_at, revoke_reason, refresh_secret_enc bytea, refresh_generation int default 0, refresh_rotated_at | `auth_sessions_user_active_idx`(user_id) WHERE revoked_at IS NULL; `auth_sessions_expires_idx`(expires_at) |
| `auth_mfa_challenges` | token_hash bytea PK, project_id, user_id, attempts, expires_at, consumed_at, created_at | `auth_mfa_challenges_expires_idx` |
| `auth_recovery_codes` | user_id → CASCADE, code_hash bytea, used_at; PK(user_id, code_hash) | — |
| `auth_events` | id bigserial PK, project_id → CASCADE, user_id uuid (no FK), type, ip, user_agent, data jsonb default '{}', created_at | `auth_events_project_idx`(project_id, id DESC); `auth_events_user_idx`(user_id, id DESC) WHERE user_id IS NOT NULL |

##### `002_data_protection.sql`
- `auth_projects` + `data_key_enc bytea`, `data_key_version integer NOT NULL DEFAULT 1`.
- `auth_sessions` + `authenticated_at timestamptz NOT NULL DEFAULT now()` (backfilled = created_at).
- Table `auth_session_revocations` (id bigserial PK, project_id text, session_id uuid, revoked_at timestamptz default `clock_timestamp()`); index `auth_session_revocations_feed_idx`(project_id, revoked_at, id).
- Function `auth_record_session_revocation()` plpgsql: UPDATE where revoked_at NULL→NOT NULL inserts row; DELETE of a still-live session (not revoked, expires_at>now, idle_expires_at>now) inserts row.
- Trigger `auth_sessions_revocation_feed` AFTER UPDATE OF revoked_at OR DELETE ON auth_sessions FOR EACH ROW.

##### Maintenance (`services/maintenance.ts`, every 5 min, lock `727455002`, batch 5 000 rows per DELETE)
- delete expired `auth_pending_signups`, `auth_email_codes`, `auth_mfa_challenges`.
- delete `auth_sessions` with expires/idle_expires/revoked < now − 7 days.
- delete `auth_session_revocations` older than 1 day.
- delete `auth_events` older than 365 days.
- then `signingKeys.retireExpired()` (retiring → retired where `retired_at <= now`).

##### Audit event types (`services/audit.ts`)
`user.signed_up`, `user.email_verified`, `user.signed_in`, `user.sign_in_failed` (data.reason `unknown_email`/`bad_password`), `user.signed_out`, `user.password_changed`, `user.password_reset`, `user.mfa_enabled`, `user.mfa_disabled`, `user.mfa_failed`, `user.recovery_code_used`, `user.deleted` (data.by self/admin), `user.disabled`, `user.enabled`, `user.metadata_updated`, `session.reauthenticated`, `session.revoked`, `session.revoked_all`, `session.refresh_token_reuse`. user_agent truncated to 512.

#### 1.5 App-database schema installed by `data-protection-sql.ts` (idempotent, one `BEGIN…COMMIT`)

- `CREATE SCHEMA IF NOT EXISTS basalt_auth`; `REVOKE ALL ON SCHEMA … FROM PUBLIC`; `GRANT USAGE … TO PUBLIC`.
- `basalt_auth.keys` (version int PK, project_id text, k_ipad bytea CHECK len=64, k_opad bytea CHECK len=64, installed_at, + `issuer text` via ADD COLUMN IF NOT EXISTS); REVOKE ALL FROM PUBLIC. Upsert `ON CONFLICT (version) DO UPDATE`.
- `basalt_auth.revoked_sessions` (session_id uuid PK, revoked_at); REVOKE ALL FROM PUBLIC.
- `basalt_auth.sync_state` (id boolean PK default true CHECK(id), revocations_synced_to timestamptz); REVOKE ALL FROM PUBLIC.
- Functions (all `SET search_path = pg_catalog, pg_temp`):

| Function | Kind | Behavior |
|---|---|---|
| `b64url_decode(text) → bytea` | sql IMMUTABLE STRICT | translate `-_`→`+/`, pad, decode base64 |
| `b64url_canonical(text) → boolean` | sql IMMUTABLE STRICT | true only for canonical base64url spelling |
| `uid() → uuid` | plpgsql STABLE SECURITY DEFINER | verifies `current_setting('basalt.grant')`; NULL if unset; raises SQLSTATE `28000` if invalid (details 1.8) |
| `authenticate(data_grant text) → uuid` | plpgsql VOLATILE SECURITY DEFINER | `set_config('basalt.grant', grant, true)` (tx-local) then `uid()`; raises 28000 `no data grant` if NULL |
| `record_revocations(uuid[], timestamptz[], synced_to timestamptz)` | plpgsql SECURITY DEFINER | insert ON CONFLICT DO NOTHING; delete revoked_sessions older than 2 h; upsert sync_state with GREATEST |
| `revocations_synced_to() → timestamptz` | sql STABLE SECURITY DEFINER | reads sync_state |
| `protect(tbl regclass, owner_column name DEFAULT 'owner_id')` | plpgsql SECURITY INVOKER | column must exist and be `uuid`; SET NOT NULL; SET DEFAULT `basalt_auth.uid()`; ENABLE + FORCE RLS; drop+create policy `basalt_owner` FOR ALL USING/WITH CHECK `(owner = (SELECT basalt_auth.uid()))` |
| `unprotected_tables() → (table_name text, owner_like_column name)` | sql STABLE | tables (relkind r/p, not pg_catalog/information_schema/basalt_auth) with column in (`owner_id`,`user_id`,`created_by`,`author_id`,`account_id`) lacking RLS+FORCE |

- `GRANT EXECUTE` on uid, authenticate, record_revocations, revocations_synced_to, unprotected_tables TO PUBLIC. `protect()` not in the explicit GRANT (Postgres default EXECUTE-to-PUBLIC applies; SECURITY INVOKER, so ALTER TABLE needs ownership → run as migration role).
- `renderDataProtectionSql` validates projectId `^prj_[A-Za-z0-9]+$`, integer version, issuer `^https?://[A-Za-z0-9.:/_-]+$`; substitutes `{{PROJECT_ID}} {{VERSION}} {{K_IPAD}} {{K_OPAD}} {{ISSUER}}` (hex).

#### 1.6 Crypto and security mechanisms (exact parameters)

##### Master key / KeyRing (`lib/crypto.ts`)
- `BASALT_AUTH_MASTER_KEY`: base64, must decode to exactly 32 bytes.
- HKDF-SHA256 (empty salt) subkeys: `encryptionKey` info `basalt-auth:encryption:v1` (32 B); `codePepper` info `basalt-auth:code-pepper:v1` (32 B).
- Encryption: AES-256-GCM, IV 12 B random, tag 16 B; blob = `0x01 | iv(12) | tag(16) | ct`; AAD strings: `signing-key:<kid>`, `refresh:<sessionId>`, `totp:<userId>`, `data-key:<projectId>:<version>`.
- `hashCode(context, code)` = HMAC-SHA256(codePepper, `${context}:${code}`); contexts `signup:<pendingId>`, `email:<codeId>`, `recovery:<userId>`.
- Identifiers: `randomToken(prefix, 32 B)` base64url; `randomId(prefix, 12 B)` base64url with `-_`→`x`; project ids `prj_…`, signing kids `key_…` (9 B); UUIDv7 for users/sessions/codes.
- Token prefixes: `bslt_sk_` (project secret key, stored SHA-256, hint = first 12 chars + `…`), `bslt_su_` (signup token, stored SHA-256), `bslt_mfa_` (MFA challenge, stored SHA-256), `bslt_rt_` (refresh).

##### Passwords (`lib/password.ts`)
- Argon2id via `node:crypto.argon2`: `DEFAULT_ARGON2 = { memoryKiB: 19456, passes: 2, parallelism: 1 }`, tag 32 B, salt 16 B; input `password.normalize('NFKC')`.
- PHC: `$argon2id$v=19$m=<m>,t=<t>,p=<p>$<b64 salt>$<b64 tag>` (unpadded). `needsRehash` if m/t lower or p differs → rehash on successful sign-in.
- `verifyDummy` (cached dummy hash) on unknown email for sign-in and reset-confirm (timing equalization). Sign-up hashes before lookup.
- Hashing runs inside `Semaphore(HASH_CONCURRENCY default max(2, cores), HASH_QUEUE_LIMIT default 200)`; overflow → 503 `server_busy`, Retry-After 2.
- Policy: min `passwordMinLength` (10–64, default 10) code points after NFKC; max 128; reject `COMMON_PASSWORDS` (lowercased); reject single repeated char; reject if contains email local-part (≥4 chars); HIBP k-anonymity (`https://api.pwnedpasswords.com/range/<5 hex SHA-1>`, header `Add-Padding: true`, UA `basalt-auth`, timeout 1500 ms, fail-open) when `checkBreachedPasswords`. Sign-in password > 1024 chars → invalid_credentials.

##### Access tokens (`services/signing-keys.ts`, `services/sessions.ts`)
- Ed25519 per project (`generateKeyPairSync('ed25519')`), private key PKCS#8 DER encrypted; JWK published with `kid`, `alg: EdDSA`, `use: sig`.
- JWT header `{alg:'EdDSA', kid, typ:'at+jwt'}`; claims: `iss = ${PUBLIC_URL}/v1/projects/<projectId>`, `aud = <projectId>`, `iat`, `exp = iat + accessTokenTtlSeconds` (60–3600, default 600), `sub` (user uuid), `sid` (session uuid), `email`, `email_verified`, `amr` (`pwd`, `otp`, `recovery`, `email`), `auth_time` (session `authenticated_at`, epoch s), `bdg` (data grant).
- Rotation: old active → `retiring` with `retired_at = now + RETIRE_AFTER_MS (3 h)`; new key active immediately; one active key per project (unique partial index). JWKS includes active+retiring. Caches: signer 60 s, JWKS 60 s (server), app-side verifier cache 30 s.

##### Sessions and refresh tokens (`services/sessions.ts`)
- Session: `expires_at = now + sessionMaxLifetimeSeconds` (3600–90 d, default 30 d); `idle_expires_at = min(expires, now + sessionIdleTimeoutSeconds)` (300 s–30 d, default 7 d); schema refine: max ≥ idle.
- Per-session 32-byte secret (encrypted, AAD `refresh:<id>`). Token: `bslt_rt_<sessionId hex32>_<generation>_<base64url HMAC-SHA256(secret, "<sessionId>:<generation>")>`; regex `^bslt_rt_([0-9a-f]{32})_(\d{1,9})_([A-Za-z0-9_-]{43})$`. O(1) storage.
- Refresh (row `FOR UPDATE`): MAC mismatch → invalid (session untouched, no DoS); generation == current → rotate (gen+1, `refresh_rotated_at`, sliding idle expiry, update ip/UA); generation == current−1 within `REFRESH_GRACE_MS = 10 000` → 409 `refresh_in_progress`; any other genuine older generation → revoke session (`refresh_token_reuse`) + audit `session.refresh_token_reuse` → 401; expired → revoke `expired`; user missing/disabled → revoke `user_disabled`.
- Revoke reasons used: `signed_out`, `revoked_by_user`, `refresh_token_reuse`, `expired`, `user_disabled`, `password_reset`, `password_changed`, `admin`.
- Sign-out accepts any genuine (even superseded) refresh token.

##### Cookies (`http.ts`)
| Cookie | Secure name / insecure name | Attributes |
|---|---|---|
| access | `__Host-basalt_at` / `basalt_at` | HttpOnly, Secure=cookieSecure, SameSite=Lax, Path=/, Max-Age = token TTL |
| refresh | `__Secure-basalt_rt` / `basalt_rt` | HttpOnly, Secure, SameSite=Strict, Path=`<mountPrefix>/session`, Max-Age = idle expiry |
- `mountPrefix` = `X-Forwarded-Prefix` (only if `TRUST_PROXY_HOPS>0`, regex `^/[A-Za-z0-9/_-]{0,200}$`) else `/v1/projects/<id>`. Browser responses never contain tokens; browser refresh never reads body token.
- Step-up (`accessResponse`) sets only the access cookie.

##### Client IP / proxies
- `TRUST_PROXY_HOPS` (0–5): client = XFF entry at index `len − hops`; must be valid IP; else socket address; default `0.0.0.0`. `::ffff:a.b.c.d` → IPv4. Rate-limit key: IPv4 as-is, IPv6 → first 4 groups `xxxx:xxxx:xxxx:xxxx::/64`.

##### CSRF / origin
- Browser = has `Origin`; must exactly match project `allowedOrigins` (403 otherwise). All JSON endpoints require `Content-Type: application/json` (non-GET) → forces CORS preflight; non-object body → 400.
- Cookie-authenticated non-GET requests require valid Origin. Secret-key API refuses any Origin. Backend SDK refuses cookie-auth writes from foreign origins (1.7).
- `OriginSchema`: exact `scheme://host[:port]`; https only, http only for `localhost`/`127.0.0.1`/`[::1]` and `*.localhost` (RFC 6761 loopback; added in the readiness pass for the demo origin); hostname regex (no wildcards); no path/query/hash/credentials; max 50.

##### Rate limits (`services/limits.ts`; sliding-window approximation; Redis Lua atomic, keys `bauth:rl:{<sha256(key) base64url[0..27]>}:<window>:<n>`, PEXPIRE 2×window; reset via SCAN)
| Rule | Key | Limit |
|---|---|---|
| signupPerIp | `su:ip:<pid>:<ipKey>` | 20 / 3600 s |
| signupPerEmail | `su:em:<pid>:<email>` | 5 / 3600 s |
| verifyPerIp | `vs:ip:…` (signup verify, resend, email verify) | 60 / 600 s |
| resendPerSignup | `rs:<sha256(token)>` | 5 / 3600 s |
| signinPerIp | `si:ip:…` | 60 / 600 s |
| signinPerAccountIp | `si:acct-ip:<pid>:<email>:<ipKey>` (reset on success) | 10 / 900 s |
| signinPerAccount | `si:acct:<pid>:<email>` | 50 / 3600 s |
| mfaPerUser | `mfa:user:<uid>` | 10 / 900 s |
| resetRequestPerIp | `rr:ip:…` | 20 / 3600 s |
| resetRequestPerEmail | `rr:em:…` | 3 / 3600 s |
| resetConfirmPerIp | `rc:ip:…` | 30 / 600 s |
| emailCodePerUser | `ev:<uid>` | 5 / 3600 s |
| refreshPerIp | `rf:ip:<pid>:<ipKey>` | 600 / 60 s |
| sensitivePerUser | `sens:<uid>` (change pw, reauth, TOTP confirm/disable, recovery regen, delete) | 10 / 900 s |
- Constants: `MAX_CODE_ATTEMPTS = 5`; `EMAIL_CODE_TTL_MINUTES = 15`; `PENDING_SIGNUP_TTL_MINUTES = 30`; `MFA_CHALLENGE_TTL_SECONDS = 300`; `RECOVERY_CODE_COUNT = 10`.

##### Email codes / anti-enumeration / pre-hijacking
- 6-digit numeric (`randomInt`), peppered HMAC, single use, 5 wrong attempts → burned (pending signup deleted; email code consumed; MFA challenge consumed). Newer email code invalidates older ones. Input normalizes spaces/dashes.
- Sign-up for existing email → same 202 + decoy `signupToken`, owner gets `account_exists` email. No user row until verified; pending signup bound to `signupToken` (SHA-256 stored). Verify deletes all pending signups for that email.
- Reset request always 202, work in background; reset confirm validates new password first (code not burned on typo), unknown user → dummy hash + invalid_code; reset sets `email_verified_at` if null, revokes all sessions, sends `password_changed`.
- Verify-email for MFA user → `email_verified` only (no session; MFA not bypassed).

##### MFA / TOTP (`lib/totp.ts`)
- RFC 6238: HMAC-SHA1, 6 digits, 30 s step; secret 20 random bytes, base32 (RFC 4648 alphabet, no padding); accepts steps now−1, now, now+1 (constant-time over all 3); rejects step ≤ `totp_last_step` (replay); stores matched step.
- otpauth: `otpauth://totp/<issuer:account>?secret=…&issuer=…&algorithm=SHA1&digits=6&period=30` (issuer = appName ?? project name).
- Recovery codes: 10 codes, 10 chars from `abcdefghjkmnpqrstuvwxyz23456789`, formatted `xxxxx-xxxxx`; stored HMAC with pepper (context `recovery:<uid>`, dash removed); single-use (`used_at`); amr `recovery`. Regenerate requires TOTP (not recovery). Disable requires password + TOTP/recovery; deletes recovery codes.
- Emails on MFA enable/disable.

##### Step-up
- `sessions.authenticated_at` set at sign-in and `/session/reauthenticate`; token `auth_time` claim. Reauth requires password and, if MFA enabled, a code (`mfa_required` if missing); amr updated to `['pwd']` or `['pwd','otp'|'recovery']`.
- SDK `requireUser(req, { maxAgeSeconds })` → 403 `reauthentication_required` when `now − authTime > maxAge`.

##### Data grants (`services/data-grants.ts`)
- Per-project 32 random bytes, lazily created (`UPDATE … WHERE data_key_enc IS NULL`), AES-GCM encrypted, AAD `data-key:<pid>:<version>`; `data_key_version` default 1; cache 60 s.
- Key used as TEXT: HMAC key = UTF-8 bytes of base64url(key) (43 chars) — "as pgcrypto hmac(text,text)".
- Token = HS256 JWT: header `{alg:'HS256', typ:'JWT', kid:'v<version>'}`; payload `{sub, sid, iat = min(now, exp−1), exp (= access token exp), aud:'authenticated', role:'authenticated', iss: <issuer>}`; signature base64url HMAC-SHA256. Embedded in access JWT claim `bdg`.
- Install SQL stores `k_ipad = (key‖0…64) XOR 0x36`, `k_opad = … XOR 0x5c` so Postgres computes HMAC with built-in `sha256()`: `sha256(k_opad ‖ sha256(k_ipad ‖ msg))`.
- `basalt_auth.uid()` checks, in order: empty → NULL; length ≤ 4096 and regex `^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$`; all 3 parts canonical base64url; JSON decode (data_exception → malformed); header object, `alg = HS256`, no `crit`, `kid ~ ^v[0-9]{1,6}$`; key version exists; MAC compare via `sha256(mac) <> sha256(sig)`; if MAC bad and `iss` differs from stored issuer → "data token is for another project"; payload: object, numeric `exp`/`iat`, `sub`/`sid` lowercase uuid regex, `aud = role = 'authenticated'`, `iss = keys.issuer`; integer exp/iat; `exp − iat ≤ 3600`; `iat ≤ now + 60`; `exp > now` where now = `statement_timestamp()`; `sid` not in `revoked_sessions`. All failures SQLSTATE `28000`.
- Revocation feed: `auth_session_revocations` rows with `revoked_at ≥ max(since, now − 2 h)` (FEED_HORIZON), keyset `(revoked_at, id)`, page 1000, `{revocations:[{sessionId, revokedAt}], hasMore, nextCursor}`; cursor = base64url(`<iso>|<id>`). `since` inclusive.
- SDK sync: `since = revocations_synced_to − 30 s` overlap; up to 100 pages; `record_revocations`. Default interval 10 s (min 1 s).

##### Mail webhook (`lib/mailer.ts`)
- POST JSON `{projectId, template, to, subject, text}`; header `basalt-signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`; timeout 5 s; non-2xx throws. Templates: `verify_email`, `account_exists`, `reset_password`, `password_changed`, `mfa_enabled`, `mfa_disabled`. Mail sent fire-and-forget (`background`), drained at shutdown.

##### Misc hardening
- Project cache 15 s; all queries filter `project_id`; control plane foreign == nonexistent (404).
- User metadata ≤ 16 KB JSON (`MAX_METADATA_BYTES`), replaces object; disabling revokes all sessions.
- Logger redaction; Redis rate-limit keys hashed (no PII).

#### 1.7 SDK public API (`auth/packages/sdk/src`)

##### `@basalt/auth/client` (`client.ts`)
- `createAuthClient(options?: { baseUrl?: string /* default '/_basalt/auth' */; fetch?: typeof fetch }): AuthClient`
- `AuthClient`: `getUser()`, `onChange(listener) → unsubscribe`, `signUp({email,password}) → {status:'verification_required'}|{status:'signed_in',user}`, `verifySignUp({code})`, `resendSignUpCode()`, `signIn({email,password}) → signed_in|{status:'mfa_required'}`, `submitMfaCode({code})`, `signOut()`, `reauthenticate({password, code?})`, `verifyEmail({email,code})`, `sendEmailVerification()`, `requestPasswordReset({email})`, `resetPassword({email,code,newPassword})`, `changePassword({currentPassword,newPassword})`, `mfa.enroll()`, `mfa.confirm({code})`, `mfa.disable({password,code})`, `mfa.regenerateRecoveryCodes({code})`, `sessions.list()`, `sessions.revoke(id)`, `sessions.revokeOthers()`, `deleteAccount({password})`, `fetch(input, init)` (credentials same-origin; on 401 refresh once and retry unless body is ReadableStream), `getConfig()`.
- Behavior: requests `credentials:'include'`; signupToken kept in `sessionStorage['basalt_auth_signup']`; mfaToken in memory only; proactive refresh `REFRESH_LEAD_MS = 60 000` before expiry (min delay 5 s); refresh serialized per page and via Web Locks `basalt_auth_refresh`; `refresh_in_progress` → wait 300 ms then `GET /session`; cross-tab `BroadcastChannel('basalt_auth')` messages `signed_in`/`signed_out`; `withRefresh` retries once on `unauthenticated`.
- Exports `BasaltAuthError(code, message, status, retryAfterSeconds?)`, types `AuthErrorCode`, `User`, `SessionInfo`.
- `User` = {id, email, emailVerified, mfaEnabled, metadata, disabled, createdAt, lastSignInAt}; `SessionInfo` = {id, createdAt, lastActiveAt, expiresAt, ip, userAgent, amr, current}.

##### `@basalt/auth/react` (`react.ts`)
- Re-exports client. `AuthProvider({children, client?, options?})`; `useAuth() → {user, loading, auth}` (throws outside provider).

##### `@basalt/auth/server` (`server.ts`)
- `createAuthServer(options?: AuthServerOptions): AuthServer`. Options: `projectId` (env `BASALT_PROJECT_ID`, regex `^prj_[A-Za-z0-9]+$`, required), `authUrl` (env `BASALT_AUTH_URL`, required), `secretKey` (env `BASALT_AUTH_SECRET_KEY`; throws if used in browser), `allowedOrigins` (env `BASALT_APP_ORIGINS` comma-sep), `internalUrl` (env `BASALT_AUTH_INTERNAL_URL` → fetch base for JWKS/admin; issuer still public), `fetch`.
- `AuthServer` methods:
  - `getUser(req, {strict?}) → AuthUser|null`: Bearer header first, else cookie `__Host-basalt_at` or `basalt_at`; cookie + unsafe method (POST/PUT/PATCH/DELETE) requires Origin == own host (`x-forwarded-host` first entry or `host`) or in allowedOrigins; no Origin → allowed only if `sec-fetch-site` absent/`same-origin`/`none`.
  - `requireUser(req, {strict?, emailVerified?, mfa?, maxAgeSeconds?})` → 401 `unauthenticated` / 403 `email_not_verified` / 403 `mfa_required` / 403 `reauthentication_required`.
  - `verifyAccessToken(token, {strict?})` (no CSRF check).
  - `middleware({...RequireUserOptions, required?})` Express: sets `req.auth`; required → JSON 401.
  - `withUserDb(pool, reqOrUser, fn(db, user), opts?)`, `dataGrant(user)`, `beginTransaction(pool, user|null, {statementTimeoutMs?}) → {client, commit, rollback}`, `syncRevocations(pool) → {synced}`, `startRevocationSync(pool, {intervalMs?=10000, onError?}) → stop`.
  - `admin`: `listUsers({limit,cursor,email})`, `getUser(id)`, `updateUser(id,{metadata?,disabled?})`, `deleteUser(id)`, `revokeSessions(id)`, `listEvents({userId,limit,before})` (calls `/admin/*` with secret key).
- `AuthUser` = {id, email, emailVerified, sessionId, amr, mfa (amr has otp|recovery), authTime: Date (auth_time ?? iat)}. Data grant kept in a `WeakMap`, never on the object.
- Verification: `jwtVerify` with `issuer`, `audience: projectId`, `algorithms:['EdDSA']`, `typ:'at+jwt'`, `clockTolerance: 5`; token must have 3 parts and ≤ 4096 chars; JWKS TTL 5 min; unknown `kid` forces refetch, cooldown 1 s; `strict` → POST `/admin/sessions/verify`.
- DB safety (`assertSafeRole`, once per pool): query `pg_roles`/`pg_class` for `rolsuper`, `rolbypassrls`, owns or can SELECT `basalt_auth.keys`; problems → throw in `NODE_ENV=production`, `console.warn` otherwise; missing schema (42P01/3F000) → error telling to run `auth_enable_data_protection`. Grant errors (28000) → `BasaltAuthError unauthenticated 401`. `beginTransaction`: `BEGIN`, optional `SET LOCAL statement_timeout = <int>`, `SELECT basalt_auth.authenticate($1)`.

#### 1.8 Auth MCP (`auth/packages/mcp/src`)

Files: `index.ts` (exports registerAuthTools, HttpControlPlane, ControlPlaneError, integrationGuide, FRAMEWORKS, RULES, reviewCode); `stdio.ts` (standalone server `basalt-auth` 0.1.0; env `BASALT_AUTH_URL`, `BASALT_AUTH_PLATFORM_KEY`, `BASALT_OWNER_ID` default `local`); `control-plane.ts` (`ControlPlane` interface + `HttpControlPlane(authUrl, platformKey, ownerId, fetch?)` calling `/v1/platform` with Bearer + `x-basalt-owner`; optional hooks `installDataProtection(projectId) → {database, appRole}`, `storeProjectSecret(projectId, key) → {envVar}`); `tools.ts`; `guides.ts`; `review.ts`.

`registerAuthTools(mcp, cp, {prefix='auth_', include?})`. Tools:

| Tool | Inputs | Description / annotations |
|---|---|---|
| `auth_integration_guide` | `framework` ∈ react, nextjs, express, hono, native, database | Tested integration code + env + rules. readOnly |
| `auth_security_rules` | — | 10 non-negotiable rules (`RULES`). readOnly |
| `auth_review_code` | `files[1..50]{path, content≤500000}` | Static review (`reviewCode`). readOnly |
| `auth_create_project` | `name 1-100`, `allowedOrigins?` (≤50), `settings?` | Creates project; prints env (secret via `storeProjectSecret` if available, else shown once). non-idempotent |
| `auth_list_projects` | — | readOnly |
| `auth_get_project` | `projectId` (`^prj_[A-Za-z0-9]+$`) | readOnly |
| `auth_update_project` | `projectId, name?, allowedOrigins? (replaces), settings?` | idempotent |
| `auth_rotate_secret_key` | `projectId` | destructive; old key invalid immediately |
| `auth_rotate_signing_key` | `projectId` | non-destructive |
| `auth_enable_data_protection` | `projectId` | Platform installs (`installDataProtection`) or returns SQL with handling instructions (`psql "$DATABASE_ADMIN_URL" -v ON_ERROR_STOP=1 -f /tmp/basalt-auth.sql && rm …`). idempotent |
| `auth_list_users` | `projectId, email?, limit 1-200?, cursor?` | readOnly |
| `auth_get_user` | `projectId, userId (uuid)` | readOnly |
| `auth_update_user` | `projectId, userId, metadata?, disabled?` | idempotent |
| `auth_revoke_user_sessions` | `projectId, userId` | destructive |
| `auth_delete_user` | `projectId, userId, confirm: literal true` | destructive |
| `auth_list_events` | `projectId, userId?, limit 1-200?, before?` | readOnly |

Settings input (all optional): requireEmailVerification, accessTokenTtlSeconds, sessionIdleTimeoutSeconds, sessionMaxLifetimeSeconds, passwordMinLength, checkBreachedPasswords, allowTotp, allowBearerTokens, appName. Errors → `isError` `Error (<code>): <message>` + details.

Review rules (`review.ts`; client-only rules apply when file looks like browser code; secrets in snippets redacted to `bslt_sk_[REDACTED]`):
critical: `hardcoded-secret-key`, `secret-key-public-env`, `secret-key-in-client`(client), `rls-disabled` · high: `server-sdk-in-client`(client), `token-in-web-storage`, `document-cookie-auth`, `jwt-decode-without-verify`, `own-jwt-signing`, `own-password-hashing`, `password-column`, `client-supplied-user-id`, `client-supplied-role`, `permissive-credentialed-cors`, `insecure-randomness`, `basalt-policy-dropped`, `data-grant-leak` · medium: `manual-authorization-header`(client), `competing-auth-library`, `unsafe-html`, `manual-grant-setting`, `auth-check-ignored`.

#### 1.9 Configuration / env vars

Server (`config.ts`):
| Var | Default / bounds | Notes |
|---|---|---|
| `NODE_ENV` | `development` (development/test/production) | |
| `PORT` | 8787 (1–65535) | |
| `PUBLIC_URL` | required URL | issuer prefix; trailing `/` stripped; https in prod |
| `DATABASE_URL` | required | |
| `DATABASE_MAX_CONNECTIONS` | 20 (1–500) | |
| `REDIS_URL` | optional | required in prod; else in-memory limits + warn |
| `BASALT_AUTH_MASTER_KEY` | required | base64 32 bytes |
| `BASALT_AUTH_PLATFORM_KEY` | required, ≥32 chars | |
| `TRUST_PROXY_HOPS` | 0 (0–5) | |
| `COOKIE_SECURE` | true (`true/false/1/0`) | false refused in prod |
| `MAILER` | `console` (`console`/`webhook`) | console refused in prod |
| `MAIL_WEBHOOK_URL` / `MAIL_WEBHOOK_SECRET` | required if webhook; secret ≥32 | |
| `HASH_CONCURRENCY` | max(2, cores) (1–256) | |
| `HASH_QUEUE_LIMIT` | 200 (1–100000) | |
| `LOG_LEVEL` | info | |
| `UV_THREADPOOL_SIZE` | set by main to max(8, cores); Dockerfile sets 16 | |

Per-project settings (`settings.ts`, strict): requireEmailVerification true; accessTokenTtlSeconds 600 (60–3600); sessionIdleTimeoutSeconds 604800 (300–2592000); sessionMaxLifetimeSeconds 2592000 (3600–7776000, ≥ idle); passwordMinLength 10 (10–64); checkBreachedPasswords true; allowTotp true; allowBearerTokens true; appName optional (1–60).

SDK env: `BASALT_PROJECT_ID`, `BASALT_AUTH_URL`, `BASALT_AUTH_SECRET_KEY`, `BASALT_APP_ORIGINS`, `BASALT_AUTH_INTERNAL_URL`, `NODE_ENV`. MCP stdio env: `BASALT_AUTH_URL`, `BASALT_AUTH_PLATFORM_KEY`, `BASALT_OWNER_ID`. E2E scripts: `AUTH_URL` (default `http://localhost:8787`), `PG_ADMIN_URL` (default `postgres://basalt:basalt@localhost:55432/postgres`).

#### 1.10 Deployment

- `auth/Dockerfile`: multi-stage `node:24-alpine`; build stage `npm ci --workspace=@basalt/auth-server --include-workspace-root`, build, `npm prune --omit=dev`; runtime `NODE_ENV=production`, `UV_THREADPOOL_SIZE=16`, `tini` entrypoint, `USER node`, `EXPOSE 8787`, HEALTHCHECK every 10 s (timeout 3 s, retries 3) `wget http://127.0.0.1:8787/healthz`, `CMD node dist/main.js`.
- `auth/docker-compose.yml` (dev only): `postgres:17-alpine` (user/pass `basalt`, db `basalt_auth`, port 55432, healthcheck `pg_isready`), `redis:7-alpine` (port 56379), `auth` (build ., NODE_ENV development, PUBLIC_URL `http://localhost:8787`, dev master key, dev platform key `dev-only-platform-key-change-me-0123456789`, COOKIE_SECURE false, TRUST_PROXY_HOPS 1, MAILER console, port 8787).
- `auth/.dockerignore`, `auth/.gitignore` present.

#### 1.11 Tests (vitest; server/sdk/mcp; real Postgres via PGlite; `pool: 'forks'`, timeouts 30 s in server config)

Counts = occurrences of `it(`/`test(`/`it.each(` per file.

| File | Count | Covers |
|---|---|---|
| `packages/server/test/flows.test.ts` | 45 | platform API (key required, insecure origins/bounds, owner scoping, user mgmt, secret never re-returned); sign-up (account only after verify, HttpOnly cookies, no enumeration, pre-hijacking, burn after 5, password policy, verification off); sign-in (identical errors, case-insensitive, per-account+IP throttle, distributed cap, origin allow-list, JSON required, JWKS-verifiable tokens, project isolation); sessions (rotation+reuse revocation, multi-generation replay, forged token harmless, browser cookie-only refresh, idle expiry, sign-out, list/revoke-others, signing-key rotation); password reset (revokes sessions, identical responses, burn after 5, change-password); MFA (TOTP replay, recovery once, challenge lock after 5, reset doesn't bypass MFA, disable needs pw+code); secret-key API (browser refused, pagination/metadata/disable/delete, strict verify, audit trail); account deletion; HTTP hardening (headers, CORS preflight, oversized bodies, unknown project 404); platform test users |
| `packages/server/test/data-protection.test.ts` | 14 | `bdg` in Data block format; signing config owner-scoped; RLS read isolation; write/update/delete isolation; fail-closed without grant; tampered/forged/expired/foreign grants → 28000; revocation sync; trigger records all session endings; key unreadable by app role; `protect()` validation + `unprotected_tables()`; idempotent install; step-up (auth_time refresh, MFA required, access cookie only) |
| `packages/server/test/primitives.test.ts` | 14 (13 `it` + 1 `it.each` × 5 RFC 6238 vectors) | TOTP vectors, ±1 drift, replay; base32; Argon2 PHC/OWASP params, salting, Unicode NFKC; semaphore shedding; rate limiter windows; KeyRing AAD binding, key size; uuidv7; email normalization; IPv6 /64; IPv4-mapped |
| `packages/server/test/helpers.ts` | 0 | `pgliteDb`, `CookieJar`, `createHarness`, `PLATFORM_KEY`, `ORIGIN`, `GOOD_PASSWORD` (also imported by api tests) |
| `packages/server/test/totp-util.ts` | 0 | TOTP helper |
| `packages/sdk/test/sdk.test.ts` | 16 | browser client (sign-up/verify w/o exposing tokens, typed errors, MFA, sign-out, transparent refresh, `auth.fetch` retry); backend SDK (cookie verification, Express req, CSRF block, requireUser emailVerified/MFA, forged/foreign/tampered tokens, strict mode, rotated keys, admin, middleware, missing config) |
| `packages/sdk/test/data.test.ts` | 8 | withUserDb scoping, rollback, signed-out rejection, grant not on user object, unsafe role refused in prod, not-installed message, revocation sync; step-up maxAgeSeconds |
| `packages/mcp/test/mcp.test.ts` | 14 | tool set + annotations; create project env; secret hidden w/ storeProjectSecret; validation errors; cross-workspace denial; user mgmt w/ delete confirm; guides/rules; install SQL w/ instructions; SQL hidden when platform installs; cross-workspace SQL denial; review flags RLS weakening, classic mistakes, browser-only rules; every guide snippet passes review |

Total: 111 test declarations (45+14+14+16+8+14); 115 executed cases after `it.each` expansion (primitives → 18).
E2E: `scripts/e2e.mjs` (project create, signup pending, console code, native verify, browser signin cookies w/o body tokens, refresh rotate, replay after 10.5 s revokes, 12 wrong sign-ins → last two 429 via Redis, audit `session.refresh_token_reuse`, JWKS single Ed25519 key without `d`); `scripts/e2e-data.mjs` (install into separate DB, restricted role `app_e2e`, RLS isolation, cross-owner insert rejected, no-grant zero rows, key table permission denied, signout + sync → 401, prod SDK refuses admin role).

#### 1.12 CI — `.github/workflows/auth.yml`

- Triggers: push/PR on paths `auth/**`, `.github/workflows/auth.yml`. `permissions: contents: read`. Concurrency `auth-${{ github.ref }}`, cancel-in-progress. Default working dir `auth`.
- Job `test` (ubuntu-latest, 15 min): checkout@v4 → setup-node@v4 (node 24, npm cache `auth/package-lock.json`) → `npm ci` → `npm audit --omit=dev --audit-level=high` → `npm run typecheck` → `npm test` → `npm run build`.
- Job `integration` (15 min): checkout → setup-node → `npm ci && npm run build` → `docker compose up -d --build --wait` → `node scripts/e2e.mjs` → `node scripts/e2e-data.mjs` → on failure `docker compose logs`.

---

### PART 2 — Basalt API (`api/`)

#### 2.1 Purpose / layout

- Backend framework for Basalt apps (`@basalt/api`) + MCP tools (`@basalt/api-mcp`) that provision/operate it. Enforces: auth by default, edge-only reachability (HMAC), origin/CSRF checks, zod validation of params/query/body/response, per-request RLS transaction with data grant, idempotency, rate limits, load shedding, timeouts, SSRF-safe fetch.
- Root `api/package.json` (`basalt-api`, workspaces `packages/framework`, `packages/mcp`, node `>=24.7.0`). `api/.gitignore` ignores `node_modules/ dist/ *.log .env .env.* (!.env.example) coverage/ .basalt/ .e2e-app/`.

| Package | Name | Exports / bins | Deps |
|---|---|---|---|
| `api/packages/framework` | `@basalt/api` 0.1.0 | `.`, `./client`, `./serve`, `./dev-edge`; bins `basalt-dev-edge` (`dist/dev-edge-cli.js`), `basalt-migrate` (`dist/migrate-cli.js`) | `@basalt/auth` (file:../../../auth/packages/sdk), `@hono/node-server`, `hono`, `ioredis`, `pg`, `undici ^8.12.3`, `zod` |
| `api/packages/mcp` | `@basalt/api-mcp` 0.1.0 | bin `basalt-api-mcp` (`dist/stdio.js`) | `@basalt/api`, `@basalt/auth-mcp` (file:../../../auth/packages/mcp), `@modelcontextprotocol/sdk`, `pg`, `zod` |
| `api/scripts/e2e-plug-and-play.mjs` | — | agent-style E2E via real MCP stdio | |

#### 2.2 Framework files (`api/packages/framework/src`)

| File | What it does |
|---|---|
| `index.ts` | Exports createApi + types, ApiError/errors/fromDatabaseError/ERROR_STATUS, `sql`/SqlQuery, signEdgeRequest/verifyEdgeSignature/EDGE_HEADER, createSafeFetch/isBlockedAddress/SafeFetchError, createLogger, `AuthUser` type, `z`, config schemas/parse/tightenAuth, createDataClient |
| `api.ts` | `createApi()`: route registration/validation, Hono app build, middleware pipeline, `runRoute`, `execute`, `LazyTransaction`, error mapping, security headers |
| `config.ts` | `ApiServiceConfigSchema`, `RouteOverrideSchema`, `parseServiceConfig`, `tightenAuth` |
| `errors.ts` | `ERROR_STATUS`, `ApiError`, `errors.*` helpers, `fromDatabaseError` (SQLSTATE → HTTP) |
| `edge.ts` | Edge HMAC sign/verify |
| `sql.ts` | `SqlQuery` + `sql` tagged template + `sql.join` |
| `data.ts` | `createDataClient` for Basalt Data block |
| `idempotency.ts` | Memory/Redis idempotency stores |
| `ratelimit.ts` | Same limiter as auth (Redis prefix default `bauth:rl:` overridden) + `ipRateLimitKey` |
| `safe-fetch.ts` | SSRF-safe undici fetch |
| `openapi.ts` | OpenAPI 3.1 generator |
| `logger.ts` | JSON logger with `child()`; redacts `/pass(word)?\|secret\|token\|authorization\|cookie\|grant\|api[-_]?key\|credit\|card\|ssn/i` |
| `serve.ts` | Node server with tuned timeouts + graceful shutdown |
| `client.ts` | Browser `createApiClient` |
| `dev-edge.ts` | Local edge (`createDevEdge`, `serveDevEdge`) |
| `dev-edge-cli.ts` | `basalt-dev-edge` CLI |
| `migrate-cli.ts` | `basalt-migrate` CLI + `migrate(dir, url, log)` |

#### 2.3 `createApi(options?: ApiOptions): Api`

##### ApiOptions
| Option | Default |
|---|---|
| `config` (object or JSON string) | `process.env.BASALT_API_CONFIG`; takes precedence over operational options |
| `basePath` | `/api` (regex `^(\/[A-Za-z0-9_-]+)*$`, not `/_basalt…`) |
| `auth` (AuthServer or options) | `createAuthServer()` from env |
| `database` `{pool?, url?, maxConnections?}` or `false` | `DATABASE_URL`; pool max `DATABASE_MAX_CONNECTIONS` ?? 10, clamped 1–100; idle 30 s, connect timeout 5 s, `application_name: basalt-api` |
| `dataUrl` | `BASALT_DATA_URL` |
| `redisUrl` | `REDIS_URL` (Redis `maxRetriesPerRequest:2, enableAutoPipelining`) |
| `edgeSecret` | `BASALT_EDGE_SECRET` |
| `allowedOrigins` | config.allowedOrigins ?? option ?? `BASALT_APP_ORIGINS` |
| `revocationSync` | config ?? option ?? `Boolean(BASALT_AUTH_SECRET_KEY)` (requires pool) |
| `limits.maxInFlight` | 512 |
| `limits.defaultTimeoutMs` | 10 000 (100–30 000) |
| `limits.defaultBodyLimitBytes` | 102 400 (1–10 MiB) |
| `limits.perIp` | 600 / 60 s |
| `env` | `NODE_ENV` or `development` |
| `logLevel` / `logger` | config.logLevel ?? option ?? (`warn` in test else `info`) |
| `remoteAddress`, `safeFetch` | test hooks |

Production refusals: `BASALT_EDGE_SECRET` missing or < 32 chars; no `REDIS_URL`; any non-https allowed origin. Dev without edge secret → warn `edge_check_disabled`.
Redis namespace: `BASALT_PROJECT_ID` sanitized (`[^A-Za-z0-9_]` removed, default `default`) → rate limit prefix `bapi:<ns>:rl:`, idempotency prefix `bapi:<ns>:idem:`. No Redis → in-memory.

##### Api
`get/post/put/patch/delete(path, config, handler)`; `fetch(request)` (builds app on first call; freezes registration); `openapi(info?)`; `routes()` → `[{method, path, key, auth, rateLimit, timeoutMs, bodyLimitBytes, disabled}]`; `close()` (stop revocation sync, close memory limiter, end owned pool, quit Redis).

##### RouteConfig
`auth?` (`'required'` default \| `'optional'` \| `'public'` \| `{mfa?, emailVerified?, maxAgeSeconds? (1–86400), strict?}`), `params?`, `query?`, `body?` (required for POST/PUT/PATCH; `null` = no body), `response` (required; `null` → 204), `status?` 200\|201\|202, `authorize?({user, params, query}) → bool`, `rateLimit?` (limit 1–100 000, window 1–86 400 s), `idempotency?` `'optional'\|'required'\|'off'` (POST/PATCH only), `timeoutMs?` (100–30 000), `cache?{maxAgeSeconds 0–86400}` (public GET only), `bodyLimitBytes?` (1–10 MiB), `summary`, `description`, `tags`.
Startup validation errors: path regex `^/(seg|:param)(/(seg|:param))*` (no wildcards/regex), `/_basalt` reserved, `:params` need params `ZodObject` containing each name, params schema without `:params`, missing response, missing body on POST/PUT/PATCH, body on GET/DELETE, invalid auth string, out-of-range numbers, cache on non-public/non-GET, idempotency on non-POST/PATCH, duplicate route, registration after serving.

##### HandlerContext (`ctx`)
| Field | Meaning |
|---|---|
| `user` | `AuthUser` (required/object auth), `AuthUser\|null` (optional), `null` (public) |
| `params`, `query`, `body` | zod-parsed outputs (body `null` if none) |
| `sql` | `SqlRunner` tagged template: `` sql`…` `` → rows; `.one` (0 rows → 404, >1 → error); `.maybeOne` (>1 → error); `.exec` → `{rows,rowCount}`. Runs in lazily opened per-request tx via `auth.beginTransaction(pool, user, {statementTimeoutMs: timeoutMs})`; commit on success, rollback on error; rejects non-tagged use and interpolated Promises; use after request → error |
| `data` | `DataClient` as signed-in user: `get(table,id)`, `list(table,{limit,after,archived})→{rows,next}`, `create(table,input,{key})`, `update`, `archive`, `restore`; POST `${BASALT_DATA_URL}/v1/data/<op>` with `Authorization: Bearer <dataGrant>`, timeout 10 s; error map denied→401, not_found→404, invalid_input→422, rate_limited→429 (Retry-After 10), unavailable→503 (2); no user → 401; no URL → error |
| `request` | `{id, ip, method, path, header(name)}` — `header()` returns undefined for `cookie`/`authorization` |
| `signal` | AbortSignal aborted on timeout |
| `fetch` | SSRF-safe fetch bound to `signal` |
| `log` | child logger with requestId |
| `reply(status, body, {location?})` | custom 2xx + Location (must match `^/(?!/)[^\s\\]*$`) |

##### Request pipeline (`build()` / `runRoute()`)
1. `/_basalt/health` → 200 `{ok:true}` unsigned, before edge check.
2. Edge check if `edgeSecret`: verify `basalt-edge-signature` over method, `pathname+search`, `x-request-id` → else 403 `direct_access_forbidden`. Request id = edge `x-request-id` if verified and matches `^[A-Za-z0-9._:-]{8,128}$`, else random UUID.
3. Client IP: last `X-Forwarded-For` entry if edge-verified, else socket. Rate-limit key IPv4 or IPv6 /64.
4. Load shed: `inFlight >= maxInFlight` → 503 `service_unavailable` Retry-After 1.
5. Origin policy: verdict `same` (Origin host == `x-forwarded-host` (edge-verified only) or `host`), `cross-allowed` (in allowedOrigins), `foreign`. OPTIONS: cross-allowed → 204 w/ ACAO, ACAC true, methods `GET, POST, PUT, PATCH, DELETE`, headers `content-type, authorization, idempotency-key, if-match`, max-age 600, `vary: Origin`; same → 204; foreign → 403. Foreign + unsafe method → 403 `origin_not_allowed` (also on public routes).
6. Maintenance → 503 (message or default, Retry-After 30); route `disabled` → 503 Retry-After 60.
7. Per-IP limit `ip:<ipKey>` (default 600/60 s).
8. Auth: `optional` → `auth.getUser`; non-public → `auth.requireUser(req, spec)`; 401 → `unauthenticated`.
9. Per-route limit key `<METHOD fullPath>:u:<userId>` or `:ip:<ipKey>`; default user 120/60 s, public 30/60 s.
10. params/query parse → 400 `invalid_request` with details; query object skips `__proto__`/`constructor`/`prototype`, repeated keys → arrays.
11. `authorize` → 403.
12. Body: `content-type` must start `application/json` (415); content-length > limit or streamed > limit → 413; invalid UTF-8/JSON → 400 `malformed_json`; schema fail → 422 `validation_failed` (≤50 issues, paths `body.x`). No body schema + unsafe method with body → 400.
13. Idempotency (default `optional` on POST/PATCH): header `Idempotency-Key` regex `^[A-Za-z0-9._:-]{8,200}$` (required mode → 400 if missing); key `<route>:<userId|ipKey>:<header>`; fingerprint SHA-256(`pathname\nrawBody`); in progress → 409 `idempotency_in_progress`; different fingerprint → 422 `idempotency_key_reused`; replay → stored status/body/location + `idempotent-replayed: true`. On handler error: ≥500/409/429 → abandon; else store error response.
14. Execute with timeout race (`timeoutMs`) → 504 `timeout` + abort.
15. Response: `response: null` → 204 (warn if data returned); else `safeParse` (strips undeclared fields) → failure logged + 500 `internal_error`; JSON with bigint→string; `cache` → `Cache-Control: public, max-age=N`.
16. Post: HEAD strips body; security headers: `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy: no-referrer`, `content-security-policy: default-src 'none'; frame-ancestors 'none'`, `cross-origin-resource-policy: same-origin`, `cache-control: no-store` when personal (user present) or unset, `vary: Cookie, Authorization` when personal; `x-request-id`; CORS for allowed origins incl. `access-control-expose-headers: x-request-id, retry-after, location, idempotent-replayed`; per-request JSON log line `{method, route, status, ms, userId}` (error level ≥500).
17. Wrong method on known path → 405 `method_not_allowed` + `Allow: <methods>, OPTIONS` (GET implies HEAD). Unknown → 404.
18. Errors: body `{error:{code, message, requestId, details?}}`; `Retry-After` (ceil), `Allow`, 401 adds `WWW-Authenticate: Bearer realm="basalt"`.
19. Revocation sync started at build when pool and sync enabled (`auth.startRevocationSync`); prod without it → warn.

##### Built-in endpoints
| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/_basalt/health` | none (works unsigned) | 200 `{ok:true}` |
| GET | `/_basalt/ready` | edge-verified in prod else 404 | 200/503 `{ok}` (pool `SELECT 1`, Redis ping) |
| GET | `/_basalt/introspect` | edge-verified in prod | `{basePath, maintenance, allowedOrigins, routes}` |
| GET | `/_basalt/openapi.json` | edge-verified in prod | OpenAPI 3.1 |
| * | `<basePath><route>` | per route | per route (GET also serves HEAD) |

##### Error codes (`errors.ts`)
400 invalid_request, malformed_json · 401 unauthenticated · 403 forbidden, email_not_verified, mfa_required, reauthentication_required, direct_access_forbidden, origin_not_allowed · 404 not_found · 405 method_not_allowed · 409 conflict, idempotency_in_progress · 410 gone · 412 precondition_failed · 413 payload_too_large · 415 unsupported_media_type · 422 validation_failed, idempotency_key_reused · 429 rate_limited · 500 internal_error · 503 service_unavailable, transaction_conflict · 504 timeout.
`errors.*`: badRequest, validation, unauthenticated, forbidden, notFound, conflict, gone, preconditionFailed, tooManyRequests(retry=1), unavailable(retry=1).
`fromDatabaseError`: 23505/23503 → 409; 23502/23514/22001/22003 → 422; 22P02/22007/22008 → 400; 42501 (RLS WITH CHECK) → 403; 28000 → 401; 40001/40P01 → 503 `transaction_conflict` (Retry-After 1); 57014 → 504; 53300/57P01/57P03 → 503 (Retry-After 2); else 500.
`toApiError` for BasaltAuthError: 401 → unauthenticated; email_not_verified/mfa_required/reauthentication_required preserved; other 403 → forbidden; 429 → rate_limited; else 503 (Retry-After 2). `SafeFetchError` → 400 `Could not fetch that URL: …`.

#### 2.4 Edge HMAC scheme (`edge.ts`)

- Header `Basalt-Edge-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>\n<METHOD uppercased>\n<path?query>\n<requestId>")>` plus `X-Request-Id: <requestId>`.
- Verify: header regex `^t=(\d{1,12}),v1=([0-9a-f]{64})$`; request id required; `|now − t| ≤ MAX_EDGE_SKEW_SECONDS = 60`; `timingSafeEqual`.
- Edge must strip client copies of signature/request-id/XFF/prefix headers and append client IP to XFF.

#### 2.5 Service config `BASALT_API_CONFIG` (`config.ts`, zod `.strict()` at every level)

| Key | Schema / bounds |
|---|---|
| `allowedOrigins` | ≤50 exact origins (`URL.origin === o`; https, http only loopback) |
| `limits.maxInFlight` | int 1–10 000 |
| `limits.defaultTimeoutMs` | 100–30 000 |
| `limits.defaultBodyLimitBytes` | 1–10 485 760 |
| `limits.perIp` | Rule `{limit 1–100000, windowSeconds 1–86400}` |
| `defaultRateLimits.user` / `.public` | Rule |
| `routes["METHOD /path"]` | key regex `^(GET\|POST\|PUT\|PATCH\|DELETE) \/[A-Za-z0-9._~:/-]*$`; value `{rateLimit?, timeoutMs? 100–30000, bodyLimitBytes? ≤10 MiB, auth? 'required' \| {mfa?, emailVerified?, maxAgeSeconds? 1–86400, strict?}, disabled?}` |
| `maintenance` | `{enabled: boolean, message? ≤200}` |
| `revocationSync` | boolean |
| `logLevel` | debug/info/warn/error |
- Parse: empty → `{}`; invalid JSON or schema → throw at startup. Unknown route keys → warn `config_unknown_route`.
- `tightenAuth(code, override)`: base default `required`; OR of mfa/emailVerified/strict, min of maxAgeSeconds; never loosens — note a code-`public` route with any override becomes `required` or object (tightened).

#### 2.6 Other framework components

- **SQL (`sql.ts`)**: `SqlQuery.toQuery()` renders `$1..$n`, flattens nested `SqlQuery` fragments, max 65 535 params; `sql` tag rejects Promise/function values; `sql.join(parts, sep = sql\`, \`)`.
- **Idempotency (`idempotency.ts`)**: TTL 24 h (`IDEMPOTENCY_TTL_SECONDS = 86400`), pending TTL 60 s; Redis `SET NX EX 60` begin, `SET EX 86400` complete, key = prefix + base64url SHA-256(key); memory store sweeps at ≥10 000 entries.
- **Rate limiter (`ratelimit.ts`)**: identical algorithm/Lua to auth; keys hashed (SHA-256, 27 chars), hash-tagged for Redis Cluster.
- **SSRF-safe fetch (`safe-fetch.ts`)**: undici `Agent` with guarded DNS `lookup` (all addresses resolved; reject if ANY blocked or none); per-hop check of scheme (http/https only), no credentials, port ∈ `ports` (default 80, 443), literal-IP check; `redirect: 'manual'`, max redirects default 3 (cap 5), 301/302/303 → GET without body; timeout default 10 s (cap 30 s) for connect/headers/body + AbortSignal; body cap default 5 MiB (cap 50 MiB) via content-length and streaming. Blocked IPv4: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4. Blocked IPv6: ::/128, ::1/128, 64:ff9b::/96, 64:ff9b:1::/48, 100::/64, 2001::/23, 2001:db8::/32, 2002::/16, fc00::/7, fe80::/10, fec0::/10, ff00::/8, plus IPv4-mapped/compatible forms. `SafeFetchError.reason`: blocked_destination, bad_url, too_many_redirects, too_large, timeout.
- **OpenAPI (`openapi.ts`)**: 3.1.0; info default `Basalt app API` 1.0.0; `:p` → `{p}`; zod → JSON Schema (`z.toJSONSchema`, io input/output); responses success + 400 + 429, non-public + 401/403, params + 404, body + 422; security schemes `session` (apiKey cookie `__Host-basalt_at`) and `bearer` (JWT); `Error` component schema.
- **serve (`serve.ts`)**: `serve(api, {port = PORT ?? 3000, hostname = '0.0.0.0', onListen})`; `maxHeaderSize` 16 KiB; `keepAliveTimeout` 65 000, `headersTimeout` 66 000, `requestTimeout` 60 000; SIGTERM/SIGINT once → close, `closeIdleConnections`, `api.close()`, exit 0; forced exit(1) after 25 s.
- **Client (`client.ts`)**: `createApiClient({baseUrl='/api', auth?, fetch?})` → `get(path,{query,signal})`, `post(path, body={}, {idempotencyKey, signal})`, `put`, `patch`, `delete`. Uses `auth.fetch` if given (refresh on 401). POST/PATCH always send `idempotency-key` (random UUID default). Retries (GET/PUT/DELETE or keyed writes) on network error and 502/503/504, max 2 retries, backoff `300·2^n` ms or `Retry-After` (≤10 s). Errors `ApiRequestError(status, code, message, requestId, details, retryAfterSeconds)`; `network_error` status 0; paths must start with single `/`.
- **Dev edge (`dev-edge.ts`)**: routes `/_basalt/auth[/*]` → `<authUrl>/v1/projects/<projectId><rest>` + `x-forwarded-prefix: /_basalt/auth`; `<apiBase>` or `/_basalt/*` → backend with HMAC signature; else frontend (or 404 text). Strips client `basalt-edge-signature, x-request-id, x-forwarded-for, x-forwarded-prefix, x-forwarded-host, x-forwarded-proto`, hop-by-hop headers, `host`; sets new request id, XFF = socket IP, x-forwarded-host/proto. Upstream failure → 502 `bad_gateway`. Removes `content-encoding`/`content-length` from responses. Listens `127.0.0.1`, default port 8080.
- **dev-edge CLI**: flags `--port` (default `BASALT_DEV_EDGE_PORT` ?? 8080), `--backend` (default `http://127.0.0.1:${PORT ?? 3000}`), `--frontend` (default `BASALT_DEV_FRONTEND_URL`); requires env `BASALT_EDGE_SECRET`, `BASALT_AUTH_URL`, `BASALT_PROJECT_ID`.
- **basalt-migrate (`migrate-cli.ts`)**: env `DATABASE_ADMIN_URL`; dir arg default `db/migrations`; files `^\d+.*\.sql$` sorted; table `basalt_schema_migrations(name PK, applied_at)`; session `pg_advisory_lock(727455101)` (+unlock); each file in own tx; refuses SQL matching DISABLE RLS, NO FORCE RLS, BYPASSRLS, DROP POLICY…basalt_owner, `basalt_auth.keys`, SUPERUSER; then reports `basalt_auth.unprotected_tables()` (exit code 2 if any; warn if schema missing).

#### 2.7 API MCP (`api/packages/mcp/src`)

| File | What it does |
|---|---|
| `index.ts` | exports registerApiTools, LocalPlatform/ApiPlatform/EnvVar, provision functions, apiGuide/API_RULES/TOPICS, reviewApiCode, scaffold |
| `stdio.ts` | MCP server `basalt` 0.1.0; registers BOTH `auth_*` (HttpControlPlane) and `api_*` tools with LocalPlatform |
| `platform.ts` | `ApiPlatform` interface + `LocalPlatform` |
| `provision.ts` | setupApp, status, readConfig/writeConfig/mergeConfig, setRoutePolicy, rotateEdgeSecret, maskEnv |
| `tools.ts` | tool registrations (`registerApiTools(mcp, {platform, auth}, {include?})`) |
| `review.ts` | `reviewApiCode` = API rules + auth `reviewCode`, dedup by rule:line, sorted |
| `scaffold.ts` | starter files |
| `guides.ts` | topics + `API_RULES` |

##### `ApiPlatform` interface
`describe()`, `readEnv(app)`, `writeEnv(app, vars|null)`, `ensureDatabase(app) → {created, database, appRole, adminRole, env}`, `adminQuery(app, sql, params?)`, `ensureRedis(app) → {created, env}`, `configureEdge(app, {edgeSecret, projectId, apiBasePath})`, `applyChanges(app) → {applied, note?}`, optional `callBackend(app, pathAndQuery)`.

##### LocalPlatform
- `stateDir` default `./.basalt` (mkdir 0700; writes `.gitignore` `*`); `<app>.json` + `<app>.env` (0600, header "Managed by the Basalt MCP tools…"); env names `^[A-Z][A-Z0-9_]*$`; dotenv quoting picks `'`/`"`/`` ` `` or throws.
- DB ident `basalt_<app with - → _>`; roles `<db>_admin` (`NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`) and `<db>_app` (same + `NOINHERIT`), passwords 24 random bytes base64url; `CREATE DATABASE … OWNER <admin>`; `REVOKE ALL ON DATABASE FROM PUBLIC`; `GRANT CONNECT` to app; as admin: `REVOKE CREATE ON SCHEMA public FROM PUBLIC`, `GRANT USAGE ON SCHEMA public` to app, default privileges SELECT/INSERT/UPDATE/DELETE on tables and USAGE/SELECT on sequences to app. Re-run keeps existing URLs unless missing.
- `ensureRedis` reuses `REDIS_URL` or assigns configured one. `configureEdge` no-op. `applyChanges` → `{applied:false, note:'Restart the backend and dev edge…'}`. `callBackend` signs GET with edge secret, request id `mcp-<16 hex>`, 3 s timeout, base `backendUrl` ?? `http://127.0.0.1:${PORT ?? 3000}`.

##### `setupApp` steps (idempotent; app regex `^[a-z][a-z0-9-]{1,40}$`)
1. Auth project: reuse `BASALT_PROJECT_ID` if exists (merge new origins) else create (writes `BASALT_PROJECT_ID`, `BASALT_AUTH_SECRET_KEY` secret); writes `BASALT_AUTH_URL`.
2. `BASALT_EDGE_SECRET` = 32 random bytes base64url if absent; `configureEdge`.
3. `ensureDatabase` → `DATABASE_URL`, `DATABASE_ADMIN_URL` (secret).
4. `ensureRedis` → `REDIS_URL`.
5. `BASALT_API_CONFIG='{}'` if absent; writeEnv.
6. Install data protection SQL via `adminQuery`.
7. `applyChanges`. Returns masked env (`•••• (secret, set)`).

##### `status` checks
Required env: BASALT_PROJECT_ID, BASALT_AUTH_URL, BASALT_AUTH_SECRET_KEY, BASALT_EDGE_SECRET, DATABASE_URL, DATABASE_ADMIN_URL, REDIS_URL, BASALT_API_CONFIG; auth project exists; allowed origins non-empty; config valid; maintenance off; `basalt_auth.keys` exists; `unprotected_tables()` empty (fix = protect SQL); runtime role not rolsuper/rolbypassrls; backend reachable via signed `/_basalt/introspect` (lists routes; notes public write routes).

##### Tools
| Tool | Inputs | Description / annotations |
|---|---|---|
| `api_setup` | `app`, `name? 1-100`, `origins? ≤50` | Provision everything idempotently; secrets never shown. idempotent |
| `api_status` | `app` | Env (masked), checks w/ fixes, effective route policies. readOnly |
| `api_get_config` | `app` | Current `BASALT_API_CONFIG`. readOnly |
| `api_update_config` | `app`, `config` (record), `replace?` | Deep-merge (null removes) or replace; full validation; nothing written on error. idempotent |
| `api_set_route_policy` | `app`, `route` ("POST /todos"), `policy` `{rateLimit?, timeoutMs?, bodyLimitBytes?, auth? ('required'\|{mfa,emailVerified,maxAgeSeconds,strict}), disabled?}` or null | Per-route override / removal. idempotent |
| `api_set_maintenance` | `app`, `enabled`, `message? ≤200` | Maintenance on/off. destructiveHint true |
| `api_rotate_edge_secret` | `app` | New 32-byte edge secret; restart needed. non-idempotent |
| `api_scaffold` | `app` | Starter files. readOnly |
| `api_integration_guide` | `topic` ∈ setup, routes, database, errors, public-routes, outbound-http, frontend, config | Guide + rules. readOnly |
| `api_security_rules` | — | `API_RULES` (10 rules). readOnly |
| `api_review_code` | `files[1..50]{path, content≤500000}` | API + auth static review. readOnly |
(stdio also mounts all 16 `auth_*` tools.)

##### Scaffold files (`scaffold.ts`)
`server/index.ts` (createApi + registerTodoRoutes + serve), `server/routes/todos.ts` (GET /todos limit 1–100 default 50, GET /todos/:id uuid, POST /todos 201, PATCH /todos/:id, DELETE /todos/:id → 204/404), `db/migrations/001_todos.sql` (todos: id uuid default gen_random_uuid(), owner_id uuid NOT NULL DEFAULT basalt_auth.uid(), title 1–200, done, created_at; index `todos_owner_created_idx(owner_id, created_at DESC)`; `SELECT basalt_auth.protect('todos')`), `src/lib/api.ts` (createAuthClient + createApiClient), `package.json (scripts to merge)` (`db:migrate`, `dev:api` with `--watch`, `dev:edge --frontend http://localhost:5173`, all `--env-file=.basalt/<app>.env`).

##### API review rules (`review.ts`) + all auth rules
critical: `sql-string-building`, `edge-check-disabled`, `tls-verification-disabled` · high: `raw-database-client` (skipped under `db/`, `scripts/`, `migrations/`), `competing-http-server`, `any-response-schema`, `dynamic-code-execution`, `env-file-edit` · medium: `public-write-route`, `unsafe-outbound-fetch`, `error-detail-leak`.

#### 2.8 Env vars read by `api/`

| Var | Reader | Default |
|---|---|---|
| `NODE_ENV` | createApi, auth SDK | development |
| `BASALT_API_CONFIG` | createApi | `{}` |
| `BASALT_EDGE_SECRET` | createApi, dev-edge-cli | none (prod requires ≥32) |
| `REDIS_URL` | createApi | none (prod requires) |
| `BASALT_APP_ORIGINS` | createApi, auth SDK | [] |
| `DATABASE_URL` | createApi | none (ctx.sql unavailable) |
| `DATABASE_MAX_CONNECTIONS` | createApi | 10 (clamp 1–100) |
| `BASALT_PROJECT_ID` | Redis namespace, auth SDK, dev-edge-cli | `default` ns |
| `BASALT_AUTH_URL`, `BASALT_AUTH_SECRET_KEY`, `BASALT_AUTH_INTERNAL_URL` | auth SDK (secret also enables revocation sync) | — |
| `BASALT_DATA_URL` | createApi (`ctx.data`) | none |
| `PORT` | serve, dev-edge-cli, LocalPlatform | 3000 |
| `BASALT_DEV_EDGE_PORT`, `BASALT_DEV_FRONTEND_URL` | dev-edge-cli | 8080 / none |
| `DATABASE_ADMIN_URL` | basalt-migrate | required |
| `BASALT_AUTH_URL`, `BASALT_AUTH_PLATFORM_KEY`, `BASALT_PG_ADMIN_URL`, `BASALT_REDIS_URL` | MCP stdio | required |
| `BASALT_STATE_DIR`, `BASALT_BACKEND_URL`, `BASALT_OWNER_ID` | MCP stdio | `.basalt` / `http://127.0.0.1:3000` / `local` |

#### 2.9 Tests (vitest, `pool: 'forks'`, 30 s timeouts; harness reuses auth server test helpers + PGlite)

| File | Count | Covers |
|---|---|---|
| `packages/framework/test/api.test.ts` | 30 (29 `it` + 1 `it.each` × 8 unsafe definitions) | edge enforcement (unsigned/tampered/stale → 403, unsigned health, request id propagation); auth default (401, bearer, public/optional, MFA/step-up 403, no cookie/authz to handlers); RLS via ctx.sql (isolation, foreign write 403, constraint 409, public no grant, rollback w/o leak, injection as values); HTTP semantics (status codes, field details, 201+Location/202/204/HEAD, field stripping, invalid response → 500, 504 timeout, headers); abuse (429+Retry-After, cross-site writes + CORS preflight, load shed 503); idempotency (replay, per-user scope); registration (8 unsafe defs, duplicates/late, prod refusal); sql tag; OpenAPI (content, not served unsigned in prod) |
| `packages/framework/test/config.test.ts` | 5 | tighten-only auth; per-route limits/body/timeout; kill switch + maintenance 503; invalid config at startup; env var + introspection |
| `packages/framework/test/data.test.ts` | 3 | ctx.data sends Auth data token; error mapping; requires user |
| `packages/framework/test/units.test.ts` | 8 (7 `it` + 1 `it.each` × 8 SQLSTATEs) | SSRF classification/refusals/DNS rebinding; edge signature binding + expiry; DB error mapping (23505→409, 23503→409, 23502→422, 22P02→400, 42501→403, 28000→401, 40001→503, 57014→504), unknown → 500; client typed errors/204, 503 retry same key, protocol-relative rejection |
| `packages/framework/test/harness.ts` | 0 | ApiHarness (AUTH_URL `https://auth.test`, APP `https://app.example.com`, EDGE_SECRET test value, signUp, call with edge true/tamper/stale) |
| `packages/mcp/test/mcp.test.ts` | 13 | api_setup (everything provisioned, secrets hidden; idempotent re-run adds origins; bad names/insecure origins); config (merge/remove/replace; out-of-bounds writes nothing; route policies tighten-only; maintenance + edge rotation; refuse before setup); api_status checks w/ fixes; tool set; scaffold + guide snippets pass reviewer; classic backend mistakes flagged; LocalPlatform 0600 git-ignored env files with quoting |

Total: 59 declarations (73 executed cases with it.each expansion).
E2E `scripts/e2e-plug-and-play.mjs` (MCP client over stdio; edge `http://localhost:18080`, backend `http://127.0.0.1:13000`): api_setup w/o secrets; writes ≥4 scaffold files; scaffold passes review; basalt-migrate; backend + dev edge; sign-up through edge (refresh cookie Path `/_basalt/auth/session`); CRUD isolation (other user 404/empty); 401 signed-out; 422/400/405; direct backend → 403 `direct_access_forbidden`; refresh through edge; api_status all pass; route policy → `201,201,429`; limits survive restart (Redis); maintenance → 503 + `Retry-After: 30`.

#### 2.10 CI — `.github/workflows/api.yml`

- Triggers: push/PR on `api/**`, `auth/packages/sdk/**`, `auth/packages/mcp/**`, `.github/workflows/api.yml`. `permissions: contents: read`; concurrency `api-${{ github.ref }}` cancel-in-progress. npm cache on both lockfiles.
- Job `test` (ubuntu-latest, 20 min): checkout@v4 → setup-node@v4 (node 24) → in `auth`: `npm ci && npm run build` → in `api`: `npm ci` → `npm audit --omit=dev --audit-level=high` → `npm run build && npm run typecheck && npm test` (build first: api-mcp typechecks against built `@basalt/api`).
- Job `plug-and-play` (20 min): in `auth`: `npm ci && npm run build && docker compose up -d --build --wait` → in `api`: `npm ci && npm run build` → `node scripts/e2e-plug-and-play.mjs` → on failure `docker compose logs` (in `auth`).

---

### Cross-cutting notes / discrepancies

- Auth README says sessions "access tokens 10 min default (max 1 h)" — matches `accessTokenTtlSeconds` 600 / 3600. README "code expiry 15–30 min" — matches 15 (email codes) / 30 (pending signup).
- README HTTP table omits `GET /v1/platform/projects/:id/data-protection/signing` (exists in `app.ts`).
- `api/README.md` says per-user default 120/min, public 30/min, per-IP 600/min — matches `api.ts`.
- `api` RedisRateLimiter default prefix is `bauth:rl:` (copied) but `createApi` always passes `bapi:<ns>:rl:`.
- Data grants are no longer `bdg1.<ver>.<pid>.<uid>.<sid>.<exp>.<HMAC>` as the auth README's ownership section describes; code mints an HS256 JWT (`kid: v<version>`, aud/role `authenticated`) — the README was corrected in the readiness pass.
- Control-plane `createVerifiedUser` checks password policy with `checkBreached: false`.
- Signing-key retire grace (3 h) > max access TTL (1 h) + caches.

---

## Appendix B: Data block and Basalt Cloud

Exhaustive inventory, checked against the code. Facts changed by the readiness pass (§11) are marked in place.

Source: `/Users/Hari/basalt`, branch `hari`, last commit touching these dirs `076559f`. Everything here was checked against the code. Paths are relative to the repo root.

---

#### 0. Top-level shape

```
app code --HTTP + user token--> Data service (data/src/server.ts) --data_role login--> basalt.api() (data/sql/04_api.sql) --> app.<table>
                                                                                           runs as exec_role, verifies the JWT itself (basalt.uid())
Claude Code --stdio MCP--> cloud/src/mcp.ts --HTTP + bsk_ key--> Basalt Cloud (cloud/src/server.ts) --superuser--> one Postgres DB per app (all data/sql/*.sql)
                                                                     |--> Basalt Auth platform API (cloud/src/auth.ts): one Auth project per app, signing secret, test users, revocations
                                                                     '--> mounts one Data handler per app at /p/<id>/...
```

- Runtime: Node >= 23.6 (`engines` in both package.json files). TypeScript runs directly with type stripping (`node src/x.ts`). Test runner: `node --test`.
- Only npm dependency: `pg` 8.23.1 (in `data/package.json`). Cloud has no dependencies. It re-uses `pg` through `data/src/index.ts` (`export { default as pg } from 'pg'`).
- Postgres 17 (`postgres:17-alpine` in `data/docker-compose.yml`).
- `data/.env` and `cloud/.env` exist locally. They are gitignored (`.gitignore`: `.env`, `node_modules/`) and not tracked.

---

#### 1. File map

##### 1.1 `data/`

| File | Lines | Purpose |
|---|---|---|
| `data/README.md` | 95 | Design, safety claims, scaling numbers, run steps, known limits. Its "68 tests" count is out of date (the file has 88). |
| `data/contract.example.json` | 43 | Example contract: table `bookings` with service, starts_at, phone, note, party_size, email, staff_id (user), photo (file) and `shareWith: "staff_id"`. |
| `data/docker-compose.yml` | 27 | Service `db`: postgres:17-alpine, container `basalt-db`, port `127.0.0.1:54329:5432`, mounts `./initdb` and `./sql` read-only plus volume `basalt_pg`, healthcheck is psql over TCP every 1s, 60 retries. |
| `data/initdb/00_init.sh` | 16 | First-boot script. Runs each `${BASALT_SQL_DIR:-/basalt/sql}/*.sql` through psql with variables `data_pw`, `jwt_secret`, `jwt_issuer`, `owner_role`, `exec_role`, `data_role`. |
| `data/package.json` | 27 | `@basalt/data` 0.1.0. Exports `.` = `src/index.ts`, `./client` = `src/client.ts`. Scripts listed in 1.3. |
| `data/.env.example` | 18 | POSTGRES_PASSWORD, BASALT_DATA_PASSWORD, BASALT_JWT_SECRET, BASALT_JWT_ISSUER, BASALT_ADMIN_URL, BASALT_DATA_URL. |
| `data/sql/01_roles.sql` | 99 | Creates the three roles and the baseline lockdown. Creates schemas `basalt` and `app` and the extension pgcrypto (in schema basalt). |
| `data/sql/02_identity.sql` | 309 | `basalt.settings`, revocations, revoked_sessions, revocation_sync, base64url helpers, `basalt.uid()`, admins, `revoke_user`, `record_revocations`, the `usage` counter and `prune_usage`. Drops the old `basalt.login(text,int,int)`. |
| `data/sql/03_audit.sql` | 101 | Audit table partitioned by month, `ensure_audit_partitions()`, `audit_row()` trigger, `touch_updated_at()` trigger. |
| `data/sql/04_api.sql` | 307 | `basalt.registry` and the single entry point `basalt.api(token, op, tbl, args)`. |
| `data/sql/05_files.sql` | 266 | File settings columns, `basalt.files`, `basalt.file_tickets`, file RLS, `file_visible`, `file_bytes_match`, `charge`, `file_usage`, `file_put`, `digest_sha256`, `file_link`, `gen_random_bytes_32`, `file_fetch`. |
| `data/src/contract.ts` | 166 | Parses and validates the contract: types, formats, limits, reserved names. |
| `data/src/schema.ts` | 167 | Turns a contract into SQL: column DDL, RLS policies, grants, indexes, triggers and the registry upsert. |
| `data/src/migrate.ts` | 99 | Applies a contract with the admin login in one transaction. Only additive changes are allowed. Has a CLI entry point. |
| `data/src/sqlrun.ts` | 119 | Minimal psql emulator (`\set`, `:'v'`, `:"v"`, `\gexec`, comments, quotes, `$tag$`) so Cloud can run `sql/*.sql` without psql. |
| `data/src/data.ts` | 276 | The `BasaltData` class: pg pool, client-side checks, cursor encoding, calls to `basalt.api` and the file functions. |
| `data/src/validate.ts` | 100 | Checks values against the contract (`checkId`, `checkValue`, `checkWrite`, `ISO_TIMESTAMP`). |
| `data/src/errors.ts` | 19 | `BasaltError` with codes `invalid_input`, `not_found`, `denied`, `rate_limited`, `unavailable`, `contract`. |
| `data/src/server.ts` | 350 | HTTP Data service: `createDataHandler`, `createDataServer`, `setServerLimits`, session-cookie handling. Has a CLI entry point. |
| `data/src/client.ts` | 80 | `createBasalt()`, the fetch client that app code imports. |
| `data/src/index.ts` | 10 | Re-exports the public API plus `pg`. |
| `data/bench/load.ts` | 104 | HTTP load test (see 6.4). |
| `data/test/helpers.ts` | 45 | `makeToken()` / `userToken()` build HS256 test JWTs. |
| `data/test/attacks.test.ts` | 924 | 88 tests in 20 describes. |
| `data/test/files.test.ts` | 221 | 16 tests in 4 describes. |

##### 1.2 `cloud/`

| File | Lines | Purpose |
|---|---|---|
| `cloud/README.md` | 45 | MCP tool table, Guard overview (the README also says "12 things"), run steps. |
| `cloud/.env.example` | 23 | CLOUD_ADMIN_URL, CLOUD_DB_HOST, CLOUD_MASTER_KEY, PUBLIC_URL, TRUST_PROXY, AUTH_URL, AUTH_PLATFORM_KEY, CLOUD_PLATFORM_KEY. |
| `cloud/Dockerfile` | 16 | Build context is the repo root. Details in 3.13. |
| `cloud/package.json` | 16 | `@basalt/cloud` 0.1.0. Scripts: `start`, `mcp`, `pretest` (`cd ../data && npm run db:reset`), `test` (`node --env-file=.env --test test/*.test.ts`, test files run concurrently). |
| `cloud/src/server.ts` | 512 | HTTP control plane, owner pages, platform API, per-app Data handler mounts, 10 s revocation sync loop. |
| `cloud/src/projects.ts` | 444 | `Projects`: the `cloud.*` schema, creating and deleting app databases, approvals, admins, stats, revocation sync, Guard check storage. |
| `cloud/src/auth.ts` | 140 | `AuthLink`: client for Basalt Auth's platform API (projects, signing secret, test users and logins, revocation feed). |
| `cloud/src/guard.ts` | 237 | `runChecks()` (the 12 live checks) and `resign()` (forges HS256 tokens). |
| `cloud/src/scan.ts` | 138 | `scanFolder()`: local code scan for data kept outside Basalt. |
| `cloud/src/receipt.ts` | 43 | `renderReceipt()`: HTML safety receipt. |
| `cloud/src/map.ts` | 137 | `renderMap()`: owner's data map (SVG diagram, PII marking, live counts). `isPersonal()`. |
| `cloud/src/summary.ts` | 91 | `summarize()` gives the plain-English rules. `loosens()` decides when approval is needed. |
| `cloud/src/secrets.ts` | 46 | `randomId`, `randomSecret`, `sha256`, `sameHash`, AES-256-GCM `encrypt`/`decrypt`. |
| `cloud/src/html.ts` | 17 | `esc()` HTML escaping and the `page()` shell (inline CSS, dark mode). |
| `cloud/src/mcp.ts` | 286 | Standalone stdio MCP server (JSON-RPC, one message per line) with 7 tools. |
| `cloud/test/auth-server.ts` | 59 | Starts the real Basalt Auth in-process (from `auth/packages/server/dist` and `auth/node_modules/@hono/node-server`) on DB `cloud_test_auth_<pid>`. |
| `cloud/test/auth-link.test.ts` | 26 | 1 test, with fetch stubbed. |
| `cloud/test/cloud.test.ts` | ~600 | 30 tests in 12 describes (2 added in the readiness pass). |
| `cloud/test/guard.test.ts` | 252 | 11 tests in 4 describes. |
| `cloud/test/scan.test.ts` | 107 | 9 tests in 1 describe. |

##### 1.3 Scripts (`data/package.json`)

| Script | Command |
|---|---|
| `db:up` | `docker compose up -d --wait` |
| `db:down` | `docker compose down` |
| `db:reset` | `docker compose down -v && docker compose up -d --wait` |
| `migrate` | `node --env-file=.env src/migrate.ts contract.example.json` |
| `serve` | `node --env-file=.env src/server.ts contract.example.json` |
| `test` | `node --env-file=.env --test --test-concurrency=1 test/*.test.ts` (`pretest` runs `db:reset`) |
| `db:upgrade` | `docker compose exec -T db sh /docker-entrypoint-initdb.d/00_init.sh` (re-applies all SQL; every file is safe to re-run) |

---

#### 2. Data block (`data/`)

##### 2.1 Roles and lockdown (`data/sql/01_roles.sql`)

Role names come in as psql variables. Defaults: `basalt_owner`, `basalt_exec`, `basalt_data` (`DEFAULT_ROLES` in `schema.ts`). Cloud uses `app_<id>_owner`, `app_<id>_exec` and `app_<id>_data`.

| Role | Attributes | What it is for |
|---|---|---|
| owner | `nologin nosuperuser nobypassrls` | Owns schemas `basalt` and `app`, every app table and most `basalt.*` functions. Nobody logs in as it. |
| exec | `nologin nosuperuser nobypassrls noinherit` | Owns `basalt.api`, `charge`, `file_put`, `file_link` and `file_visible`. RLS policies target this role. |
| data | `login ... nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication connection limit 50` | The Data service login. Its password is `:data_pw`. |

- Data role session settings: `statement_timeout=3s`, `transaction_timeout=5s`, `idle_in_transaction_session_timeout=2s`, `lock_timeout=1s`, `work_mem=4MB`, `temp_file_limit=16MB`, `search_path=pg_catalog`.
- `revoke create on schema public from public`.
- `revoke connect, temporary on database <d> from public` for every database that allows connections. A dropped database is skipped. A concurrent change is retried up to 5 times with `pg_sleep(0.05*attempt)`. The current database is always done.
- `grant connect on database <current> to data_role`.
- Execute revoked from public on pg_catalog functions matching `^lo_`, `loread`, `lowrite`, `^pg_(try_)?advisory`, `^pg_sleep`, `pg_cancel_backend`, `pg_terminate_backend` and `pg_notify`.
- `alter default privileges [for role owner/exec] revoke execute on functions from public`.
- pgcrypto is installed in schema `basalt`. Execute on all of its functions is revoked from public. Only `basalt.hmac(text,text,text)`, `basalt.digest(bytea,text)` and `basalt.digest(text,text)` are granted, to the owner role. `05_files.sql` also grants `basalt.gen_random_bytes(integer)` to owner.
- `revoke all on schema app from data_role`, `grant usage on schema basalt to data_role`, `grant usage on schema basalt, app to exec_role`.
- In total the data role can execute only `basalt.api`, `basalt.file_put`, `basalt.file_link` and `basalt.file_fetch`.

##### 2.2 Settings and identity tables (`data/sql/02_identity.sql`)

`basalt.settings` is a single row (`id int primary key default 1 check (id = 1)`):

| Column | Default | Check |
|---|---|---|
| `jwt_secret text not null` | from `:jwt_secret` | `length >= 32` |
| `jwt_issuer text` | `nullif(:jwt_issuer,'')` | none |
| `max_token_seconds int` | 3600 | 60..86400 |
| `reads_per_minute int` | 600 | > 0 |
| `writes_per_minute int` | 60 | > 0 |
| `max_file_bytes int` (added in 05) | 5242880 (5 MiB) | 1024..52428800 |
| `file_quota_bytes bigint` (added in 05) | 52428800 (50 MiB) | > 0 |

- The row is inserted with `on conflict (id) do nothing`, so upgrades never overwrite the secret or issuer. To rotate, an admin runs `update basalt.settings set jwt_secret = ...` by hand.
- exec role column grants: `select (id, reads_per_minute, writes_per_minute)` and `select (max_file_bytes, file_quota_bytes)`. exec cannot read `jwt_secret`. Only owner-owned SECURITY DEFINER functions read it.

Other tables (all owned by owner, `revoke all from public`):

| Table | Columns | Notes |
|---|---|---|
| `basalt.revocations` | `uid uuid pk`, `before timestamptz` | Per-user "log out everywhere" cutoff. |
| `basalt.revoked_sessions` | `sid uuid pk`, `revoked_at timestamptz` | Session ids synced from Basalt Auth. |
| `basalt.revocation_sync` | `id=1`, `synced_to timestamptz` | High-water mark of the sync. |
| `basalt.admins` | `uid uuid pk`, `added_at` | People the app owner made admins. |
| `basalt.usage` (UNLOGGED) | `uid, minute, reads, writes`, pk `(uid, minute)`, index `usage_minute` | Rate-limit counters. exec has select/insert/update/delete. |

##### 2.3 `basalt.uid()`: token verification

`stable security definer`, owned by owner, execute granted only to exec. It reads the token from the GUC `basalt.jwt`, which `api()` and `charge()` set. It returns a uuid or NULL, and NULL means every policy denies.

Steps in order:
1. Shape. The token must be non-null, `length <= 4096` and match `^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$`, so the signature is exactly 32 bytes.
2. Canonical base64url. Each part must re-encode to exactly itself (`b64url_canonical`). This rejects padding, whitespace and alternate spellings that differ only in unused bits.
3. The settings row must have a secret. If not, it raises `basalt: signing secret is not configured`.
4. Fast path (cache). GUC `basalt.verified` = `uid|exp|hex(hmac('basalt-verified|'||tok||'|'||uid||'|'||exp, secret))`. It is accepted when the uid looks like a uuid, `exp` is 1..12 digits and greater than now, and the sha256 of the presented HMAC equals the sha256 of the recomputed one. `api()` and `charge()` clear this GUC on entry.
5. Signature. `digest(b64url_decode(sig),'sha256')` must equal `digest(hmac(h||'.'||p, secret,'sha256'),'sha256')`. Comparing digests blunts timing attacks.
6. Header. It must be a JSON object with `alg` exactly `HS256` and no `crit` key. **`kid` and `typ` are not checked. There is no key-id or multi-key support.** There is one secret per database.
7. Payload. It must be an object with numeric `exp`, numeric `iat` and string `sub`.
8. Whole seconds. `exp` and `iat` must be integers and `exp <= 99999999999`.
9. Time, using `statement_timestamp()` (statement time, not transaction start):
   - `exp > now`
   - `iat <= now + 60`. **Clock skew allowance: 60 s for future-dated iat. There is no skew allowance on exp.**
   - `exp - iat <= max_token_seconds`. **Maximum lifetime defaults to 3600 s.**
   - If `nbf` is a number it must be `<= now`.
10. `sub` must not be `00000000-0000-0000-0000-000000000000`. Both `aud` and `role` must equal `authenticated`.
11. Issuer. When `settings.jwt_issuer` is set, `iss` must equal it exactly.
12. User revocation. If `basalt.revocations.before` exists for the uid, the token is rejected when `iat <= epoch(before)`.
13. Session revocation. If the payload has `sid`, it must be a string matching the lowercase uuid regex, and it must not be in `basalt.revoked_sessions`.
14. On success it sets the `basalt.verified` cache note (transaction-local) and returns the uid.
15. `exception when data_exception then return null` covers malformed base64, UTF-8, JSON or uuid. Other errors propagate. Nothing grants access on error.

Related functions (all SECURITY DEFINER, owner-owned, execute revoked from public; only the superuser can call them unless noted):

| Function | Behavior |
|---|---|
| `basalt.is_admin()` | `exists(admins where uid = uid())`. exec can execute. |
| `basalt.add_admin(uuid)` / `basalt.remove_admin(uuid)` | Insert with on conflict do nothing / delete. |
| `basalt.revoke_user(uuid)` | Upserts `before = greatest(old, clock_timestamp())`, so the cutoff only moves forward. |
| `basalt.record_revocations(sids uuid[], revoked_ats timestamptz[], synced_to timestamptz)` | Inserts with on conflict do nothing. Deletes revoked_sessions older than `max_token_seconds + 10 min` (fallback 2 h). Sets `synced_to = greatest(old, new)`. |
| `basalt.revocations_synced_to()` | Returns `revocation_sync.synced_to`. |
| `basalt.prune_usage()` | Deletes usage rows older than 5 min and returns the count. |
| `basalt.b64url_decode(text)`, `basalt.b64url_canonical(text)` | Immutable helpers. |

##### 2.4 Audit (`data/sql/03_audit.sql`)

- `basalt.audit(id bigint default nextval(audit_id_seq), at timestamptz default now(), actor uuid, table_name, op, row_id uuid, columns text[])`, primary key `(at, id)`, `partition by range (at)`, default partition `basalt.audit_default`.
- Upgrading from an unpartitioned table renames it to `basalt.audit_before_partitioning` (along with its pkey and `audit_at` index).
- `basalt.ensure_audit_partitions()` creates `basalt.audit_YYYY_MM` for this month and the next 2. Rows already in the default partition for that range are moved before attaching. It runs at the end of `03_audit.sql` and on every migrate.
- `basalt.audit_row()` is an AFTER trigger. It inserts `(uid(), tg_table_name, tg_op, new.id, cols)`.
  - INSERT: `cols` = every key of the new row (including system columns and `request_key`).
  - UPDATE: `cols` = keys whose value changed, excluding `updated_at`.
  - Column names only, never values.
- `basalt.touch_updated_at()` is a BEFORE UPDATE trigger that sets `updated_at = now()`.
- Per table (from `schema.ts`): `basalt_touch` and `basalt_audit_update` fire only `when (old.* is distinct from new.*)`. `basalt_audit_insert` fires on every insert.
- The data and exec roles have no access to audit. Cloud reads it with the superuser for the data map.

##### 2.5 Contract format (`data/src/contract.ts`)

```json
{ "tables": { "<table>": { "fields": { "<field>": { "type": "...", "required": true, "maxLength": 100, "format": "email", "min": 1, "max": 20 } }, "shareWith": "<user field>" } } }
```

| Rule | Value |
|---|---|
| Name regex (tables and fields) | `^[a-z][a-z0-9_]{0,40}$` |
| Reserved names | `id`, `owner_id`, `created_at`, `updated_at`, `archived_at`, `request_key`, `select`, `from`, `where`, `table`, `user`, `order`, `group` |
| Tables | 1..50 (`MAX_TABLES`) |
| Fields per table | 1..60 (`MAX_FIELDS`) |
| Allowed table keys | `fields`, `shareWith` |
| Allowed field keys | `type`, `required`, `maxLength`, `format`, `min`, `max`. Any other key is an error. |
| Objects | Must be plain (`Object.getPrototypeOf(v) === Object.prototype`). |
| `required` | Only `true` counts as required. |
| `maxLength` | Text only, integer 1..10000. Default 1000 (`DEFAULT_MAX_LENGTH`), stored on every field spec. |
| `format` | Text only, one of the keys of `FORMATS`. Free-form regexes are refused. |
| `min` / `max` | integer and number only. Must be finite. For integer they must be whole and in the int32 range. `min <= max`. |
| `shareWith` | Must name a field of type `user`. Only one per table. |
| Errors | `BasaltError('contract', ...)` |

Field types and the SQL they produce (`schema.ts` `columnSql`):

| type | SQL type | DB checks | Client check (`validate.ts`) |
|---|---|---|---|
| `text` | `text` | `char_length <= maxLength`, plus `~ FORMAT` when a format is set | String. Length counted in code points. No `\u0000`. Format regex with the `u` flag. |
| `integer` | `integer` | `>= min`, `<= max` | `Number.isInteger`, int32 range, min/max |
| `number` | `double precision` | `<> 'NaN'`, not ±Infinity, min/max | Finite number, min/max |
| `boolean` | `boolean` | none | boolean |
| `timestamp` | `timestamptz` | `isfinite()` | String matching `ISO_TIMESTAMP` that `Date.parse` accepts |
| `user` | `uuid` | `<> '0000...0000'` | UUID regex, lowercased |
| `file` | `uuid` (no FK) | none (api checks visibility) | UUID regex, lowercased |

`required` adds `not null`. Formats (`FORMATS`) are linear-time and mean the same thing in JS and Postgres:

| Format | Regex |
|---|---|
| `email` | `^[^@\s]{1,64}@[^@\s]{1,255}$` |
| `phone` | `^\+?[0-9 ()-]{7,20}$` |
| `url` | `^https?://[^\s]+$` |
| `postal_code` | `^[A-Za-z0-9 -]{3,10}$` |
| `slug` | `^[a-z0-9]{1,80}(-[a-z0-9]{1,80}){0,20}$` |

Other regexes in `validate.ts`:
- `UUID`: `^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` with the `i` flag. Versions 1 to 8 and the RFC variant only.
- `ISO_TIMESTAMP`: `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$`. A zone is required.

`checkWrite(table, input, mode)` rejects:
- non-objects,
- unknown keys (including `owner_id`, `id` and `__proto__`; message `"<key>" is not a field you can set on <table>`),
- a missing required field on create,
- an update with no fields (`Nothing to update.`).

Columns are emitted in contract order. `null` is allowed only for non-required fields.

##### 2.6 Tables generated per contract table (`data/src/schema.ts` `tableSql`)

Table `app."<name>"`:
- `id uuid pk default gen_random_uuid()`
- `owner_id uuid not null default basalt.uid()`
- the contract fields
- `request_key text check (char_length <= 200)`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`
- `archived_at timestamptz`

`ALTER ... ADD COLUMN IF NOT EXISTS` statements backfill `request_key` and `archived_at` on old tables.

Every migrate runs these statements in order:
1. `owner to <owner>`, `enable row level security`, `force row level security`.
2. `revoke all on t from public, <data>, <exec>`.
3. Drop **every** policy on the table (looping over `pg_policies`).
4. Indexes:
   - `<t>_owner_recent (owner_id, created_at desc, id desc)`
   - `<t>_recent (created_at desc, id desc)`
   - unique `<t>_request_key (owner_id, request_key) where request_key is not null`
   - if shared: `<t>_shared_recent (<share>, created_at desc, id desc)`
5. Policies, all `to <exec>`:
   - `basalt_select`: `owner_id = (select basalt.uid())` [`or <share> = (select basalt.uid())`] `or (select basalt.is_admin())`
   - `basalt_insert`: with check `owner_id = (select basalt.uid())`. Admins cannot insert on behalf of others.
   - `basalt_update`: using and with check `owner_id = uid() or is_admin()`
   - **There is no delete policy and no delete grant.**
6. Grants to exec: `select`, `insert (<fields>, request_key)`, `update (<fields>, archived_at)`. The data role gets nothing on app tables.
7. Triggers: `basalt_touch`, `basalt_audit_insert`, `basalt_audit_update` (drop and recreate).
8. Upsert into `basalt.registry(table_name, columns = SYSTEM_COLUMNS + fields, writable = fields, share_field, spec = {fields:{...full FieldSpec}, shareWith?})`.

Other details:
- `SYSTEM_COLUMNS` = `id, owner_id, created_at, updated_at, archived_at`. These are returned by the API. `HIDDEN_COLUMNS` = `request_key`, which is never returned or writable through `input`.
- `quoteIdent` only accepts `^[a-z][a-z0-9_]{0,62}$`. `quoteLiteral` doubles quotes and refuses NUL.

##### 2.7 Migrate rules (`data/src/migrate.ts`)

- Runs as the admin URL (`BASALT_ADMIN_URL`) in a single `begin ... commit`, and rolls back on any error.
- `findRoles()` reads the role names from the catalog:
  - owner = owner of schema `app`
  - exec = owner of `basalt.api(text,text,text,jsonb)`
  - data = the first EXECUTE grantee on api that is not its owner
  - If any is missing it fails with `This database has no Basalt security setup...`.
- For each table:
  - If `app.<t>` exists but has no registry row, it refuses (`already exists but wasn't made by Basalt`).
  - If a registry row exists, `plan()` compares the stored spec with the new one. Any of the following refuses with `The contract changes table X: <why>. Changing that needs a reviewed migration, so nothing was applied.`:
    - `shareWith` differs, including when it is added or removed (`who it is shared with changed`)
    - a stored field is missing (`field X was removed`)
    - a stored field's spec is not `isDeepStrictEqual` (`the rules for field X changed`). This covers any change to type, required, maxLength, format, min or max, including loosening.
    - a new field is required (`new field X is required, and existing rows have no value for it`)
  - New optional fields get `alter table ... add column`.
  - Then the full `tableSql` re-runs, rebuilding grants, policies and the registry.
- At the end it runs `select basalt.ensure_audit_partitions()`.
- It returns `{ tables, added: ['t.f', ...] }`.
- CLI usage: `node --env-file=.env src/migrate.ts contract.json`.

##### 2.8 `basalt.api(token text, op text, tbl text, args jsonb) returns jsonb` (`data/sql/04_api.sql`)

`volatile security definer`, `search_path = pg_catalog, basalt, pg_temp`, owned by exec, execute granted only to the data role. It returns `{ok:true, data}` or `{ok:false, code, message}`.

Processing order:
1. It requires `transaction_isolation = 'read committed'`, otherwise it returns `denied` (`Calls must run at read committed isolation.`).
2. It clears `basalt.verified` and sets `basalt.jwt = coalesce(token,'')`. Both are transaction-local.
3. `op` must be one of `get`, `list`, `create`, `update`, `archive`, `restore`. Otherwise it returns `invalid_input` `Unknown operation.`
4. `args` must be a JSON object.
5. `tbl` must exist in `basalt.registry`. Otherwise it returns `invalid_input` (`There's no table with that name in this app's contract.`).
6. The cost is set by the DB:
   - list: `limit` must be a JSON number matching `^[0-9]{1,3}$`, 1..100, default 20. Cost is `reads = limit`.
   - get: reads = 1.
   - create, update, archive and restore: writes = 1.
7. `u := uid()`. NULL returns `denied` (`Your login is missing, expired or not valid. Log in again.`).
8. Charge: upsert `usage(u, date_trunc('minute', statement_timestamp()))` adding the cost. With probability 0.001 it also prunes usage rows older than 5 min. If `reads > reads_per_minute` or `writes > writes_per_minute` it returns `rate_limited` (`Too much activity in the last minute. Slow down.`). The charge commits with the call even if the operation fails, because the operation runs in a sub-block.
9. The operation runs in a `begin ... exception` sub-block. The select list is `reg.columns` (system columns plus fields), always `%I`-quoted.

Operations:

| op | args | Behavior |
|---|---|---|
| `get` | `{id}` | `select cols from app.t where id = $1`, under RLS. No row returns `not_found` `No <t> with that id.` |
| `list` | `{limit?, archived?, where?, sort?, after?, after_id?}` | Detailed below. Returns a JSON array of up to `limit + 1` rows. |
| `create` | `{input, key?}` | `input` keys must all be in `reg.writable`, else `That is not a field you can set.` A non-null `file` field must reference a row in `basalt.files` visible under files RLS, else `That file doesn't exist or isn't yours.` `key`, if present, must match `^[A-Za-z0-9_-]{1,200}$`. It runs `insert ... select <keys>, $2 from jsonb_populate_record(null::app.t, $1) on conflict (owner_id, request_key) where request_key is not null do nothing returning *`. When there is no row and a key was given, it returns the existing row for `(owner_id=u, request_key=key)`. |
| `update` | `{id, input}` | Same writable and file checks. Empty input returns `Nothing to update.` It runs `update app.t t set k = v.k ... from jsonb_populate_record(null::app.t, $2) v where t.id = $1 returning t.*`. RLS decides which rows can change. No row returns `not_found`. |
| `archive` | `{id}` | `set archived_at = coalesce(archived_at, now())`, so re-archiving keeps the original time. Needs the update policy (owner or admin). A shared reader gets `not_found`. |
| `restore` | `{id}` | `set archived_at = null`. Same policy as archive. |

List semantics:
- `archived`: must be a boolean if present. `true` returns only rows with `archived_at is not null`. The default (absent or false) returns only rows with `archived_at is null`.
- `where`: an object with at most 10 keys. Each key must be in `reg.columns`, so system columns are allowed.
  - Equality values may be string, number or boolean. They are collected into `$5` and compared as `col = (jsonb_populate_record(null::app.t, $5)).col`, so values are typed through the row type and are never SQL text.
  - Range values are an object with keys in {gte, gt, lte, lt}, at least one, each a string or number. They are collected per operator into `$6..$9` (gte, gt, lte, lt) and compiled to `>=`, `>`, `<=`, `<`.
  - Any other value type returns `Filter values must be text, numbers or true/false.`
- `sort`: `{field, direction?}`. The field must be `created_at`, `updated_at` or a field with `required: true` in the stored spec. The direction is `asc` or `desc` (default `desc`). The default sort is `created_at desc`. Ties break on `id` in the same direction.
- Cursor: `after` (an object holding the sort field's value) plus `after_id` (uuid). Both are needed, else `That page cursor is not valid.` The condition is `(sort_col, id) < | > ((populate($2)).sort_col, $3)`.
- Admins (`is_admin()`) get a single scan: `where cond order by ... limit $1`, where `$1` = limit + 1.
- Everyone else gets `(select ... where owner_id = $4 and cond order ... limit $1)`, plus `union (select ... where <share_field> = $4 and cond order ... limit $1)` when the table is shared. The result is then re-ordered and limited again. RLS still applies.

Exception mapping inside the sub-block:

| SQLSTATE | Code returned |
|---|---|
| `query_canceled` (57014, caught explicitly) | `unavailable` "That took too long and was stopped." |
| `23502` on column `owner_id` | `denied` "You need to be logged in to do that." |
| `42501` | `denied` "You don't have access to do that." |
| `23514`, `23502`, `23505`, `22xxx` | `invalid_input` "That value isn't allowed." |
| `55P03`, `25P04`, `40001`, `40P01` | `unavailable` "took too long" |
| anything else | `unavailable` "The database is unavailable right now." |

Registry table: `basalt.registry(table_name pk check '^[a-z][a-z0-9_]{0,40}$', columns text[], writable text[], share_field text, spec jsonb)`. exec has select.

##### 2.9 Files (`data/sql/05_files.sql`)

- `basalt.files(id uuid pk default gen_random_uuid(), owner_id uuid not null default basalt.uid(), name text 1..200 chars, content_type text in ALLOWED, size int > 0, sha256 text '^[0-9a-f]{64}$', data bytea, created_at)`. Index `files_owner (owner_id, created_at desc)`. RLS is enabled and forced.
- Grants: exec gets `select` and `insert (name, content_type, size, sha256, data)`. The data role gets nothing.
- Policies:
  - `basalt_files_select` (exec): `owner_id = uid() or is_admin() or file_visible(id)`
  - `basalt_files_owner` (owner role, select, `true`), used by `file_fetch` and `file_usage`
  - `basalt_files_insert` (exec): `owner_id = uid()`
- `basalt.file_tickets(ticket text pk '^[0-9a-f]{64}$', file_id uuid fk files, expires_at)`, index on `expires_at`. exec has select, insert and delete.
- `file_visible(fid)` (exec-owned): for every registry field with `type='file'`, it checks `exists(select 1 from app.<t> where <f> = fid)` under the caller's RLS. This is how a shared reader can open a photo attached to a booking that is shared with them.

Allowed MIME types and byte checks (`file_bytes_match`):

| content_type | Bytes required |
|---|---|
| `image/png` | First 8 bytes `89 50 4E 47 0D 0A 1A 0A` |
| `image/jpeg` | `FF D8 FF` |
| `image/gif` | `GIF87a` or `GIF89a` |
| `image/webp` | `RIFF` at 1..4 and `WEBP` at 9..12 |
| `application/pdf` | `%PDF-` |
| `text/plain`, `text/csv` | No NUL byte, valid UTF-8, no control characters other than TAB, LF and CR (`[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]` refused) |

SVG, HTML and executables are refused because they are not on the list.

Functions:

| Function | Grant | Behavior |
|---|---|---|
| `charge(token, cost_r, cost_w) returns uuid` | none (called internally) | Same isolation check, GUC reset, `uid()` and usage upsert as api. Over the limit it raises SQLSTATE `P0429`. A bad token returns NULL. |
| `file_put(token, fname, ctype, body)` | data | 1. Charges 1 write (`P0429` returns `rate_limited`, NULL returns `denied`). 2. Size must be 1..`max_file_bytes`, else `Files can be up to N MB.` 3. Type must be in the allowed list. 4. Bytes must match the type; any error also gives `That file's contents don't match its type.` 5. Per-user quota: `file_usage(u) + size > file_quota_bytes` gives `You've used all your file storage. Remove some files first.` 6. Name cleaning: `regexp_replace('[^[:alnum:] ._-]+','_')`, btrim `' ._'`, empty becomes `file`, then `left(…,200)`. 7. Inserts with sha256. Returns `{id, name, content_type, size, created_at}`. |
| `file_usage(uid) returns bigint` | exec | Sum of `size` for the owner. Owner-owned, so it skips RLS and stays one index scan. |
| `file_link(token, fid)` | data | Charges 1 read. The file must be visible under RLS, else `not_found` `No file with that id.` The ticket is 32 random bytes as hex (64 chars) with `expires_at = now() + 5 min`. With 1% probability it purges expired tickets. Returns `{ticket, expires_in: 300}`. |
| `file_fetch(t)` | data | Owner-owned, stable. Returns `(name, content_type, data)` for a ticket matching the regex that has not expired. **Tickets are not deleted on use.** They can be reused until they expire, despite the "one time style" comment. |
| `digest_sha256(bytea)` | exec | `sha256(body)` |
| `gen_random_bytes_32()` | exec | `gen_random_bytes(32)` |

Limits summary: **5 MiB per file in the DB by default** (configurable 1 KiB..50 MiB). **The HTTP service caps uploads at 6 MiB** so that the DB returns the clear message. **50 MiB quota per user.** **Download links last 5 minutes.**

##### 2.10 Damage limits: exact numbers

| Limit | Value | Where |
|---|---|---|
| Reads per user per clock minute | 600 (`settings.reads_per_minute`) | `api`, `charge` |
| Writes per user per clock minute | 60 (`settings.writes_per_minute`) | `api`, `charge` |
| list cost | `limit` reads (1..100, default 20) | `api` |
| get cost | 1 read | |
| create, update, archive, restore cost | 1 write each | |
| `file_put` cost | 1 write | |
| `file_link` cost | 1 read | |
| `file_fetch` cost | not charged (the ticket is the proof) | |
| Failed operations | Still charged (charge happens before the sub-block) | |
| Usage row retention | Pruned when older than 5 min (0.1% chance per api call, or `prune_usage()`) | |
| Max token lifetime | 3600 s (60..86400) | `uid()` |
| Data role connections | 50 | 01 |
| Statement / transaction / idle-in-transaction / lock timeouts | 3 s / 5 s / 2 s / 1 s | 01 |
| `work_mem` / `temp_file_limit` | 4 MB / 16 MB | 01 |

README "known limits": a fully compromised data login can wrap the call in its own transaction and roll back to undo the charge. It can also change its own session GUCs (timeouts, work_mem).

##### 2.11 `BasaltData` (`data/src/data.ts`)

- Constructor `{connectionString, contract, poolSize?}`. The pg Pool uses `max = poolSize ?? 10`, `connectionTimeoutMillis 2000`, `idleTimeoutMillis 30000`, `query_timeout 4000`, `application_name 'basalt-data'`. Pool `error` events are swallowed.
- Client-side token shape `TOKEN`: `^[A-Za-z0-9_-]{2,1024}\.[A-Za-z0-9_-]{2,3000}\.[A-Za-z0-9_-]{43}$`. A mismatch gives `denied`.
- Methods: `get`, `list`, `create`, `update`, `archive`, `restore`, `uploadFile`, `fileLink`, `fetchFile`, `close`, and the getter `contract`.
  - `get(token, table, id)`
  - `list(token, table, {limit, after, archived, where, sort})` returns `{rows, next}`
  - `create(token, table, input, {key?})`
  - `update(token, table, id, input)`
  - `archive(token, table, id)` and `restore(token, table, id)`
  - `uploadFile(token, name, contentType, body)` calls `basalt.file_put`
  - `fileLink(token, id)` returns `{ticket, expires_in}`
  - `fetchFile(ticket)` returns `{name, content_type, data}` or null. It checks the ticket against `^[0-9a-f]{64}$` first.
- Each call is one `select basalt.api($1,$2,$3,$4::jsonb) as r` in autocommit, which works with PgBouncer transaction pooling.
- `list` checks on the client:
  - `limit` is an integer 1..100 (default 20).
  - sort field is in [created_at, updated_at, required fields], direction asc or desc.
  - `checkWhere`: at most 10 keys. Keys must be contract fields or `SYSTEM_COLUMNS`. Field values go through `checkValue` with `required:true`, so null is refused. System `*_at` keys need an ISO timestamp. `id` and `owner_id` need a uuid. Range ops are gte, gt, lte and lt.
  - `archived` must be a boolean.
- Cursor: `base64url(JSON.stringify([sortField, row[sortField], row.id]))`. On decode: at most 2000 chars, a 3-element array, element 0 equal to the current sort field, a primitive value, the value matching `CURSOR_TIME` for created_at and updated_at, and a uuid id. Any failure gives `That page cursor is not valid for this sort.` `next` is non-null only when the DB returned `limit + 1` rows.
- `create` key regex: `^[A-Za-z0-9_-]{1,200}$`.
- Error mapping: pg errors `57014`, `25P04` and `55P03` give `unavailable` "took too long". Any other pg error gives `unavailable` "database is unavailable". A DB reply code not in the known set becomes `unavailable`. Raw DB errors never leave the class.

##### 2.12 HTTP Data service (`data/src/server.ts`)

`createDataHandler(options)` returns `(req, res, path) => Promise<void>`. Cloud mounts one per app. `createDataServer` wraps it in `http.createServer` and strips the query string.

Options and defaults:

| Option | Default |
|---|---|
| `maxBodyBytes` | 64 KiB |
| `maxInFlight` | 256 |
| `maxListBytes` | 1 MiB |
| `bodyTimeoutMs` | 5000 (uploads get 6x, so 30 s) |
| `maxFileBytes` | 6 MiB |

`setServerLimits(server)` sets `requestTimeout 10000`, `headersTimeout 5000`, `keepAliveTimeout 5000` and `maxHeadersCount 50`.

Routes:

| Method / path | Auth | Body | Response |
|---|---|---|---|
| `OPTIONS *` | none | | 204 with CORS headers |
| `GET /healthz` | none | | 200 `{ok:true}`. Never touches the DB. |
| `GET /v1/files/download/<64 hex>` | ticket in the URL | | 200 with the raw bytes. Unknown, malformed or expired tickets get 404 `That link is wrong or has expired.` |
| `POST /v1/files` | Bearer or cookie | Raw bytes. `content-type` is the MIME type (lowercased, params stripped). `x-file-name` is URI-encoded and cut to 300 chars. | 200 `{ok, data:{id,name,content_type,size,created_at}}`. Counts toward in-flight. |
| `POST /v1/files/link` | Bearer or cookie | `{id}` | 200 `{ok, data:{path:'/v1/files/download/<ticket>', expires_in:300}}` |
| `POST /v1/data/get` | Bearer or cookie | `{table, id}` | row |
| `POST /v1/data/list` | Bearer or cookie | `{table, limit?, after?, archived?, where?, sort?}` | `{rows, next}` |
| `POST /v1/data/create` | Bearer or cookie | `{table, input, key?}` | row |
| `POST /v1/data/update` | Bearer or cookie | `{table, id, input}` | row |
| `POST /v1/data/archive` | Bearer or cookie | `{table, id}` | row |
| `POST /v1/data/restore` | Bearer or cookie | `{table, id}` | row |
| anything else | | | 404 `{ok:false, error:{code:'not_found', message:'Unknown route.'}}` |

- Envelope: `{ok:true, data}` or `{ok:false, error:{code, message}}`.
- Status per code: `invalid_input` 400, `denied` 401, `not_found` 404, `rate_limited` 429, `unavailable` 503, `contract` 500.
- JSON response headers: `content-type application/json; charset=utf-8`, `cache-control no-store`, `x-content-type-options nosniff`, plus CORS.
- CORS: `access-control-allow-origin: *`, methods `POST, GET, OPTIONS`, headers `authorization, content-type, x-file-name`, `max-age 600`. Credentials are never allowed.
- Download headers:
  - `content-disposition` is `inline` for `image/*` and PDF, `attachment` for everything else. The filename has `[^A-Za-z0-9 ._-]` replaced with `_`.
  - `content-security-policy: default-src 'none'; sandbox`
  - `cache-control: private, max-age=300`
  - `nosniff`, plus CORS
- JSON body rules:
  - `content-type` must match `^application/json(;|$)`.
  - A declared `content-length` over the max is refused before reading.
  - A streamed size over the max is refused.
  - A slow body is destroyed after `bodyTimeoutMs`, giving `The request body took too long or was cut off.`
  - The body must be a JSON object.
- Load shedding: when `inFlight >= maxInFlight` it returns 503 `unavailable` with `retry-after: 1`. A slot is held until the response `close` event. This applies to `/v1/data/*` and `/v1/files`, but not to `/v1/files/link` or downloads.
- `list` responses over `maxListBytes` are trimmed by `fitPage`: rows are popped from the end while more than one remains, and `next` is re-pointed at the last kept row.

Authentication (`bearer()`), which runs before the body is read:
1. If an `Authorization` header is present, it must match `^Bearer (\S{1,4096})$` and the token must match `TOKEN`. Otherwise 401.
2. If there is no Authorization header, the session cookie is used (`fromSessionCookie`):
   - A `Cookie` header is required.
   - The request must be same-origin: `new URL(Origin).host === (X-Forwarded-Host first value || Host)`. If not, 401 `Cookie logins only work from the app's own site.` A missing Origin is refused (CSRF protection).
   - Cookie names `__Host-basalt_at` or `basalt_at` (the last one present wins).
   - The value must split into 3 segments with a payload of at most 8000 chars. The payload is decoded and the claim **`bdg`** is taken as the data token, which must match `TOKEN`.
   - The outer cookie JWT's signature (EdDSA from Basalt Auth) is **not** verified here. Only the inner `bdg` token is verified, by the DB.
3. An explicit Authorization header always takes precedence over the cookie.

CLI: `node --env-file=.env src/server.ts contract.json`. Env vars: `BASALT_DATA_URL` (required), `BASALT_POOL_SIZE` (10), `HOST` (`127.0.0.1`), `PORT` (8787).

##### 2.13 Client (`data/src/client.ts`)

`createBasalt({ url?, token?, timeoutMs? })`:
- `url` defaults to `'/_basalt/data'`, which is the same-origin mount on hosted apps. Trailing slashes are stripped.
- `token` is a string or a (possibly async) function. When it is absent, no Authorization header is sent and `credentials: 'same-origin'` lets the HttpOnly cookie go out. With a token, `credentials: 'omit'`.
- `timeoutMs` defaults to 10000 through `AbortSignal.timeout`. Uploads get 3x.

API:
- `data.get(table, id)`, `data.list(table, opts)`, `data.create(table, input, {key?})`, `data.update(table, id, input)`, `data.archive(table, id)`, `data.restore(table, id)`. Each is `POST ${base}/v1/data/<op>`.
- `files.upload(blob, name = file.name ?? 'file')` sends `POST ${base}/v1/files` with `content-type: blob.type` and `x-file-name: encodeURIComponent(name)`.
- `files.url(id)` returns `base + path` from `POST /v1/files/link`.
- Network failures throw `BasaltError('unavailable', "Couldn't reach Basalt. Try again.")`. A reply that is not JSON throws `unavailable`. `{ok:false}` throws `BasaltError(error.code, error.message)`.

##### 2.14 Error codes (all layers)

| Code | HTTP | Typical cause |
|---|---|---|
| `invalid_input` | 400 | Contract violation, bad id, cursor, filter, key or file; body too big or not JSON |
| `denied` | 401 | Missing, invalid, expired or revoked token; RLS 42501; owner_id NOT NULL from a null uid; cookie not same-origin |
| `not_found` | 404 | Row missing or not visible (looks the same either way); unknown route; bad ticket |
| `rate_limited` | 429 | Over the per-minute limit |
| `unavailable` | 503 | Timeout, DB down, load shed, unexpected reply |
| `contract` | 500 (data server) / 400 (Cloud catches BasaltError) | Contract parse error |

##### 2.15 SQL runner (`data/src/sqlrun.ts`)

- `splitSql(text, vars)` splits on `;` outside quotes, `--` and `/* */` comments, and `$tag$` bodies.
  - `\set` lines are dropped when they are at the start of a line.
  - `\gexec` ends the statement and marks it gexec.
  - `:'name'` becomes a quoted literal (NUL refused). `:"name"` becomes `"ident"`, which must match `^[a-z][a-z0-9_]{0,62}$`.
  - A missing variable throws. A `"` right after `:` is not treated as an identifier quote.
- `runSql(client, text, vars)` runs each statement with `rowMode:'array'`. For gexec statements it executes every non-empty string cell of the result as SQL.

---

#### 3. Basalt Cloud (`cloud/`)

##### 3.1 Environment variables

| Var | Used by | Default / required |
|---|---|---|
| `CLOUD_ADMIN_URL` | server | Required. Superuser URL to the `postgres` database. |
| `CLOUD_DB_HOST` | server | Required. `host:port` put into per-app data URLs. |
| `CLOUD_MASTER_KEY` | server | Required. 64 hex chars (32 bytes), else `key()` throws. |
| `AUTH_URL` | server | Required. Basalt Auth base URL. |
| `AUTH_PLATFORM_KEY` | server | Required. Bearer for Auth `/v1/platform/*`. |
| `CLOUD_PLATFORM_KEY` | server | Optional. When unset, the platform API always returns 401. |
| `PUBLIC_URL` | server | Default `http://${HOST}:${PORT}`. Used in all returned links. |
| `TRUST_PROXY` | server | `'1'` enables X-Forwarded-For / X-Forwarded-Host logic. |
| `HOST` | server | `127.0.0.1` (the Dockerfile sets `0.0.0.0`) |
| `PORT` | server | 8790 |
| `BASALT_URL` | mcp | `http://127.0.0.1:8790` |
| `BASALT_PROJECT_DIR` | mcp | `process.cwd()` |

These are hard-coded and not configurable through env in `main`:
- `maxProjects` 500
- `projectsPerIpPerHour` 10
- `selfUrl` `http://127.0.0.1:${port}`
- Guard concurrency: 4 in total, 1 per app
- Data handler cache: 200
- Per-app pool size: 3
- Auth owner (workspace): `basalt-cloud`

##### 3.2 Cloud schema (`Projects.init()`, `cloud/src/projects.ts`)

`init()` runs in one transaction holding `pg_advisory_xact_lock(hashtext('basalt cloud init'))`. It creates schema `cloud` and revokes all on it from public.

| Table | Columns |
|---|---|
| `cloud.projects` | `id text pk`, `name`, `db_name unique`, `owner_role`, `exec_role`, `data_role`, `data_password` (encrypted), `jwt_secret` (encrypted), `admin_key_hash` (sha256 hex), `approved_contract jsonb`, `created_at`, `owner_view_key` (encrypted), `auth_project_id`, `auth_owner`, `external_id` (unique partial index `projects_external_id`), `hosted bool default false` |
| `cloud.approvals` | `id text pk`, `project_id fk`, `token_hash` (sha256), `contract jsonb` (nullable), `status in (pending, approved, rejected, replaced)`, `created_at`, `decided_at`, `kind in (rules, admin) default 'rules'`, `admin_uid uuid`, `admin_label` |
| `cloud.checks` | `id identity pk`, `project_id fk`, `results jsonb`, `findings jsonb` (nullable; null means no scan was sent), `created_at`, `contract_hash`. Index `(project_id, created_at desc)`. Only the newest 20 are kept per project. |

After that transaction, `init()` backfills: `update cloud.projects set hosted = true where not hosted and auth_owner is not null and auth_owner <> 'basalt-cloud'`.

##### 3.3 Secrets handling (`cloud/src/secrets.ts`)

| Item | Format | Stored as |
|---|---|---|
| Project id | `randomId(10)` over `[a-z0-9]` (byte % 36) | plain |
| DB name and roles | `app_<id>`, `app_<id>_owner`, `app_<id>_exec`, `app_<id>_data` | plain |
| Data role password | `randomSecret()`, 32 bytes base64url | **AES-256-GCM with CLOUD_MASTER_KEY** (`iv(12).tag.ciphertext`, base64url, dot-joined) |
| JWT signing secret (from Auth) | Auth project's secret | **AES-256-GCM.** Written but never read back by Cloud: Guard fetches it again through `auth.signing()`. |
| Owner view key (map and receipt `?k=`) | `randomSecret()` (43 chars), created lazily once | **AES-256-GCM**. Compared with `sameHash` (sha256 plus timingSafeEqual). |
| Admin key | `bsk_<id>_<randomSecret 43>` | sha256 hex. Checked by regex `^bsk_([a-z0-9]{10})_[A-Za-z0-9_-]{43}$` and then `sameHash`. |
| Approval token | `randomSecret()` (43) | sha256 hex. The approval id is `randomId(16)`. |
| Test user password | `Tp-` + base64url(HMAC-SHA256(masterKey, `test-user|<authProjectId>|<email>`)) | Not stored (derived) |
| Platform key check | sha256 of presented key vs sha256 of the configured key with `timingSafeEqual` | env only |

##### 3.4 HTTP routes (`cloud/src/server.ts`)

Request handling:
- `/api/*` JSON bodies are capped at 256 KiB (413 when over). An empty body is treated as `{}`. Invalid JSON gives 400 and a non-object gives 400.
- Approval form POST bodies are capped at 4096 bytes.
- Error shapes:
  - `HttpError` gives `{ok:false, error:{message}}` with the status it carries.
  - A `BasaltError` that escapes gives 400 `{ok:false, error:{code, message}}`.
  - Anything else gives 500 `Something went wrong on our side.` and is logged.
- HTML pages are sent with:
  - `x-frame-options: DENY`
  - `referrer-policy: no-referrer`
  - `CSP default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'`
  - `cache-control: no-store`
  - `nosniff`

| Method | Path | Auth | Purpose | Status codes |
|---|---|---|---|---|
| GET | `/healthz` | none | liveness | 200 |
| any | `/p/<id 10>/<rest>` | the app's data token (Bearer or cookie), handled by the Data handler | That app's Data API: every route in 2.12, including `/healthz`, files and downloads | **404** when the project is `hosted`, `TRUST_PROXY` is on and `X-Forwarded-Host == host(PUBLIC_URL)` (hosted data is served only on the app's own site). **503** `This app's data rules haven't been approved yet.` when the project is unknown or has no approved contract (OPTIONS gets 204; ACAO `*`). Otherwise the Data handler's codes. |
| GET | `/owner/<id>?k=<key>` | owner view key | Data map | 200, or 404 on a bad key. With no rules yet: a 200 page saying so. |
| GET | `/owner/<id>/check?k=<key>` | owner view key | Safety receipt | 200; 404 bad key; 200 "hasn't been checked yet". The receipt is marked stale when `sha256(JSON(approved_contract)) != check.contract_hash`. |
| GET | `/approve/<id 16>?t=<token>` | approval token | Approval page | 200; 404 bad id or token; 410 already decided |
| POST | `/approve/<id 16>` | form `t`, `decision=approve` (any other value rejects) | Decide | 200 approved or rejected; 404; 410; 409 when apply fails (rules) |
| POST | `/api/projects` | none (per-IP limit) | Create an app | 201 `{ok, project: status, adminKey}`; 400 no name; 429 over the per-IP limit; 503 over `maxProjects` |
| GET | `/api/projects/me` | `Bearer bsk_...` | Status | 200; 401 |
| PUT | `/api/projects/me/rules` | bsk | Set the contract | 200 `{status:'live', summary}`; 202 `{status:'waiting_for_owner', approveUrl, why[], summary}`; 400 invalid contract (`The rules aren't valid yet: ...`); 409 migrate refusal; 401 |
| POST | `/api/projects/me/test-login` | bsk | Test person login | 200 `{who, userId, token, expiresInSeconds}`; 409 when there is no `authProjectId`; 401 |
| POST | `/api/projects/me/admins` | bsk | Request an admin | 202 `{status:'waiting_for_owner', approveUrl, userId}`; 409 no approved rules or no Auth project; 400 neither who nor userId; 401 |
| POST | `/api/projects/me/check` | bsk | Guard | 200 `{passed, failed, results, codeFindings, receiptUrl}`; 409 no rules or no Auth project; 429 a check is already running for this app; 503 when 4 checks are already running; 401 |
| POST | `/api/platform/projects` | platform key | Create a DB bound to an existing Auth project | 201 `{ok, project, adminKey}`; 400; 401; 404 via edge; 409 env bound to a different Auth project |
| DELETE | `/api/platform/environments/<externalId>` | platform key | Delete by environment id | 200; 404 `Unknown environment.` |
| PUT | `/api/platform/projects/<id>/rules` | platform key | Apply rules immediately, no owner approval (for test environments) | 200 `{status:'live', summary}`; 409 on any parse or migrate error; 404 unknown project |
| DELETE | `/api/platform/projects/<id>` | platform key | Delete project | 200; 404 |
| any | anything else | | | 404 `Unknown route.` |

Notes per route:
- **`POST /api/projects`**
  - `name`: string, trimmed, cut to 80 chars, required.
  - Client IP is the first `X-Forwarded-For` value when `trustProxy` is on, otherwise `socket.remoteAddress`.
  - The per-IP window is a sliding hour (`3_600_000` ms) kept in an in-memory `Map`.
  - `projectCount` is an in-memory counter that starts at 0 on each boot. It does not count existing rows.
- **`status(p)`** returns:
  - `id`, `name`
  - `dataUrl` = `${PUBLIC_URL}/p/<id>`
  - `status` = `live` (approved contract exists), `waiting_for_owner` (pending rules approval) or `no_rules_yet`
  - `rules` (plain-English text, or null)
  - `waitingForOwner` (bool)
  - `mapUrl` = `${PUBLIC_URL}/owner/<id>?k=<ownerViewKey>`
- **test-login**: `who` must match `^[A-Za-z0-9 _-]{1,40}$`, otherwise it silently becomes `'test person'`.
- **admins**:
  - `userId` must match the uuid v1-8 regex; `label` is optional and cut to 60 chars (default `'this person'`).
  - Alternatively `who` (same regex as test-login) is resolved to that test person's Auth user id through `testLogin`.
- **check**:
  - `scan` is passed through `cleanFindings`: at most 100 entries. `rule` is cut to 40 chars; `file`, `problem` and `fix` to 300; `line` must be a positive safe integer, else 0.
  - A missing or non-array `scan` becomes `findings = null`.
- **Platform auth (`requirePlatform`)**:
  - When `trustProxy` is on and **any** `X-Forwarded-For` header is present, it returns 404, so the API is invisible through the edge.
  - The presented Bearer must equal `CLOUD_PLATFORM_KEY`, else 401 `Platform key required.`
- **Platform create body**:
  - `name` (cut to 80)
  - `authProjectId` must match `^prj_[A-Za-z0-9]{8,40}$`
  - `authOwner` must match `^[A-Za-z0-9_.:-]{1,200}$`
  - `externalId` is optional and must match `^[A-Za-z0-9_-]{1,64}$`
- After rules are applied, an approval, or a delete, `dropHandler(id)` closes the cached Data handler and its pool, so the new contract is loaded on the next request.
- Data handler cache: a `Map` of at most 200 entries. When full, the oldest inserted entry is evicted. Each entry is a `BasaltData` with `poolSize: 3`, connected through `projects.dataUrl(p)` = `postgres://<data_role>:<pw>@<CLOUD_DB_HOST>/<db>`.

##### 3.5 Project lifecycle (`cloud/src/projects.ts`)

**Create** (`Projects.create(name, attach?)` / `#create`):
1. Generate `id`, `dbName`, role names, data password and admin key (see 3.3).
2. Auth binding:
   - Without `attach`: `auth.createProject(name)` calls `POST /v1/platform/projects {name: name.slice(0,100), allowedOrigins: []}` and then `auth.signing(projectId)`. `authOwner` is `'basalt-cloud'`.
   - With `attach` (platform API only): `auth.signing(attach.authProjectId, attach.authOwner)` is used and no Auth project is created.
3. `#createDatabase(dbName, vars)`:
   - Opens a **dedicated connection** and takes the global session lock `pg_advisory_lock(hashtext('basalt cloud create database'))`. Only one setup runs at a time across all Cloud instances, because role and grant changes conflict. The lock is held on its own connection to avoid a pool deadlock.
   - Runs `create database "<dbName>"`.
   - Connects to the new database and runs every `data/sql/*.sql` in sorted order through `runSql` with `{data_pw, jwt_secret: signing.secret, jwt_issuer: signing.issuer, owner_role, exec_role, data_role}`.
   - Ending the connection releases the lock.
   - `max_token_seconds` is **not** set from `signing.maxTokenSeconds`, so it stays at the default 3600.
4. On failure: the Auth project is deleted when it was not attached, and `drop database if exists ... with (force)` runs. The cluster-wide roles created by `01_roles.sql` are not dropped on this path.
5. Insert the `cloud.projects` row with the encrypted password and secret, the sha256 of the admin key, `auth_project_id`, `auth_owner`, `external_id` and `hosted = Boolean(attach)`.
6. Return `{project, adminKey}`. The admin key is shown only once.

**Platform create with `externalId`** (idempotent):
1. Opens a dedicated connection and takes `pg_advisory_lock(hashtext('basalt cloud env <externalId>'))`.
2. Looks up an existing row by `external_id`:
   - Different `auth_project_id` or `auth_owner`: `ConflictError`, which becomes 409.
   - Same binding: **rotates** the admin key (new `bsk_`, hash updated) and returns the existing project. The old key stops working.
   - No row: runs `#create`.
3. Tests cover concurrent bursts of 8 for one environment (all 201, a single DB).

**Delete** (`Projects.delete(p)`):
1. `drop database if exists "<db>" with (force)`
2. `drop role if exists` for data, exec and owner
3. Delete the project's approvals and checks, then the project row.

The Auth project is **not** deleted. `deleteByExternalId(externalId, beforeDelete)` takes the same per-environment advisory lock, so it waits for an in-flight create. It returns false (404) when the environment is unknown.

**get(id)**:
- Requires `^[a-z0-9]{10}$` and decrypts `data_password`.
- `hosted` = `r.hosted || external_id != null`.
- `authOwner` defaults to `'basalt-cloud'`.

**apply(p, contract)**:
1. `parseContract` (throws `BasaltError('contract')`).
2. `migrate(adminUrl with /<db>, contract)`.
3. Save `approved_contract`.

**stats(p)** runs as superuser on the app DB:
- active and archived counts for each registry table (the name is re-checked against the name regex),
- `basalt.files` count and total bytes,
- `basalt.admins` count,
- the last 8 audit rows `(at, table_name, op, columns)`.

Values are never read.

##### 3.6 AuthLink (`cloud/src/auth.ts`)

Platform calls go to `${AUTH_URL}/v1/platform${path}` with headers `authorization: Bearer <AUTH_PLATFORM_KEY>` and `x-basalt-owner: <owner>` (default `'basalt-cloud'`) and a 10 s timeout. A non-2xx reply throws an Error carrying `status` and `code`.

| Method | Auth API call |
|---|---|
| `createProject(name)` | `POST /projects {name ≤100, allowedOrigins: []}`, then `signing()` |
| `signing(projectId, owner)` | `GET /projects/<id>/data-protection/signing` returns `{secret, issuer, maxTokenSeconds}` |
| `deleteProject(projectId)` | `DELETE /projects/<id>` (errors swallowed) |
| `testLogin(projectId, who, owner)` | `POST /projects/<id>/users {email, password}` (409 is ignored), then **non-platform** `POST ${AUTH_URL}/v1/projects/<id>/signin {email, password}` with no Origin, so the tokens come back in the body |
| `revocations(projectId, {since?, cursor?}, owner)` | `GET /projects/<id>/data-protection/revocations?cursor=..|since=<ISO>` returns `{revocations:[{sessionId, revokedAt}], hasMore, nextCursor}` |

Test logins:
- Email: `who.toLowerCase().trim()`, whitespace and `_` become `-`, anything outside `[a-z0-9-]` is stripped, an empty result becomes `test`, then `@test.basalt.invalid` is appended.
- Password: `Tp-` + HMAC(masterKey, `test-user|<pid>|<email>`). On a 401 it retries with the legacy password HMAC(masterKey, `test-user|<pid>|<lowercased trimmed name>`).
- Token returned: the **`bdg` claim** of `accessToken` (the data token). The user id is `body.user.id`.
- Cache: keyed `projectId|email`, reused until 2 minutes before `exp`, capped at 5000 entries (the oldest is evicted).

##### 3.7 Revocation sync loop

- In `server.ts` main: `setInterval(sync, 10_000).unref()`.
- It skips a round while the previous one is still running, then works through `linkedProjectIds()` (projects with `auth_project_id`, oldest first) with `REVOCATION_SYNC_CONCURRENCY` workers (default 4), running `syncRevocations(p)` and logging errors per project. (Before the readiness pass this was one sequential loop that could overlap itself.)
- Standalone `pg.Client`s made by `connect()` have an `'error'` listener, so a database dropped `WITH (FORCE)` mid-sync fails only that sync instead of crashing Cloud (readiness pass; regression-tested).
- `syncRevocations(p)`:
  1. Connects to the app DB as superuser.
  2. `last = basalt.revocations_synced_to()`.
  3. The first page uses `since = last - 30 s` (overlap for out-of-order commits), or no `since` when nothing has been synced yet.
  4. Follows `nextCursor` while `hasMore`, for at most 100 pages.
  5. For each non-empty page it calls `basalt.record_revocations(sids, revokedAts, lastRevokedAtOfPage)`.
  6. Returns the count.
- The DB rejects tokens whose `sid` is in `revoked_sessions` (see 2.3 step 13). The comment's target is "within ~10 seconds".

##### 3.8 Approvals flow

- **What counts as "loosens"** (`summary.ts` `loosens(approved, next)`):
  - There is no approved contract yet: `['These are the first rules for this app.']`. The first rules always need approval.
  - A **new table** has `shareWith`: `New <t> can be seen by the person in "<f>".`
  - An **existing table** sets or changes `shareWith`: `<t> would be shown to the person in "<f>".`
  - Nothing else counts. New unshared tables and new optional fields apply immediately (200 live). Removed fields, changed rules and removed or changed sharing are not "loosening" but are refused by migrate (409).
- When it loosens: `requestApproval(p, contract)` runs in a transaction. It marks any older **pending `rules`** approval for the project as `replaced`, then inserts a new one. It returns `approveUrl = ${PUBLIC_URL}/approve/<id16>?t=<token>`.
- Admin requests (`requestAdmin`) insert `kind='admin'` with `admin_uid` and `admin_label`. **They do not replace** earlier pending admin requests.
- GET approve page:
  - rules: a warning that lists `loosens()` reasons against the *current* approved contract, the plain-English summary cards, and a form with hidden `t` and buttons `decision=approve` / `decision=reject`.
  - admin: a warning that an admin "can see and change everything".
- POST decision:
  - rules approve: `apply()`. A failure gives 409 "These rules couldn't be applied" and the approval stays pending. Success marks it `approved` and drops the handler.
  - admin approve: `basalt.add_admin(uid)` in the app DB, then marked `approved`.
  - any other decision: `rejected`, and nothing changes.
- `decide()` only updates rows where `status='pending'`.
- **Expiry: none based on time.** Links stop working only once decided (410) or replaced (410 "replaced by a newer request"). A bad id or token gives 404, and the 404 page text says "mistyped or expired".
- `pendingApproval()` considers only `kind='rules'`.

##### 3.9 Admins

- DB side: `basalt.admins` and `is_admin()`. Admins can select every row (policy), update any row (including the `user` share field, so they can assign staff), and archive or restore. They **cannot insert** rows owned by others (the insert policy requires `owner_id = uid()`). On files, admins can see any file.
- The data role cannot call `add_admin` (test: "the Data service's login cannot make anyone an admin"). Only the superuser can, which means Cloud after owner approval.
- There is no remove-admin route in Cloud (`remove_admin()` exists in SQL only).

##### 3.10 Data map (`cloud/src/map.ts`)

- `isPersonal(name, spec)` is true for:
  - `type==='file'`,
  - text with format `email`, `phone` or `postal_code`,
  - or a name matching `/(name|phone|email|mail|address|street|city|zip|postal|birth|dob|ssn|social|passport|license|card|iban|account|salary|health|medical|diagnos|allerg|note|message|comment)/i`.
- The page shows:
  - a header line: N kinds of data, files count, MB, admins count;
  - an SVG diagram;
  - per-table cards with `active saved, archived`, fields (personal fields in red with a "personal" tag) and a sharing sentence;
  - "Recent changes" from the last 8 audit rows (e.g. "a new booking was added" or "a booking changed (cols)"), with relative times (just now, min, h, days).
- Diagram actors:
  - `Each customer`: all tables, green
  - `Assigned person`: shared tables only, blue
  - `Admins (n)`: all tables, orange
  - `The AI that built it` and `A hacker`: red dashed line with ✕ and "no key"
  - Table boxes have a red border when any field is personal.
- It never shows values. A test asserts the phone value is absent.

##### 3.11 Guard (`cloud/src/guard.ts`, invoked by `POST /api/projects/me/check`)

Setup in `server.ts`:
1. Two real Auth test people: `testLogin(pid, 'basalt check a')` and `'basalt check b'`.
2. `signing` comes from Auth.
3. Target URL = `${selfUrl ?? PUBLIC_URL}/p/<id>`. Cloud calls itself directly so hosted environments are not hidden.
4. `forged` = A's token re-signed (`resign`) with a random 48-byte key.
5. `expired` = A's token re-signed with the **real** secret and `iat = now-7200`, `exp = now-3600`.

`refused(r)` means: a JSON body with boolean `ok`, `ok` false, and a 4xx status other than 429. Network errors (status 0), 429 and 5xx count as "Couldn't tell", which **fails** the check. Each request has a 10 s timeout. At most 20 tables are checked (`MAX_TABLES`).

**The 12 checks (result `id`):**

| # | id | Title | What it does | Passes when |
|---|---|---|---|---|
| 1 | `no_login` | Someone with no login | `list` of the first table with no Authorization | refused |
| 2 | `bad_token` | A made up login | `list` with `Bearer not-a-real-token` | refused |
| 3 | `forged_token` | A forged login for a real person | `list` with A's claims signed by a random key | refused |
| 4 | `expired_token` | An expired login | `list` with A's correctly-signed but expired token | refused |
| 5 | `unknown_table` | Reading the database's own tables | B runs `list {table:'pg_authid'}` | refused |
| 6 | `other_person_file` | Downloading someone else's file | Only when some table has a `file` field. A uploads `text/plain` "Basalt safety check" (`basalt-check.txt`). B asks for `/v1/files/link` on it. A failed upload fails the check. | refused |
| 7 | `other_person_get` (per table) | Opening someone else's entry | B runs `get` on A's row | B did not get A's id, and the reply was refused or ok |
| 8 | `other_person_list` (per table) | Listing everyone's entries | B runs `list` | B got rows back and A's id is not among them |
| 9 | `other_person_update` (per table) | Changing someone else's entry | `change()` picks the first field of type text, boolean, timestamp or number that has a valid alternative value. B updates it, then A reads it back. | B's update was refused, the value is unchanged, **and** A can make the same update (control). No changeable field means fail ("Couldn't tell"). |
| 10 | `other_person_archive` (per table) | Removing someone else's entry | B runs `archive` on A's row | refused |
| 11 | `fake_owner` (per table) | Saving an entry in someone else's name | B runs `create` with `owner_id: userA` added | The row was not created with `owner_id == A`, and the reply was refused or ok. A row B did create is archived by B. |
| 12 | `filter_injection` (per table, only when a text field exists) | A search that tries to sneak in database code | B runs `list where {<first text field>: "x' or '1'='1"}` | A's id is not in the rows, and rows were returned or the request was refused |

Per-table flow:
1. A creates `sampleInput`. Optional `user` and `file` fields are skipped. Sample values:
   - text: format sample (`a@b.co`, `5550100`, `http://a.co`, `94103`, `a`) or `'Basalt check'` cut to maxLength
   - numbers: `clamp(1, min, max)`
   - boolean: `true`
   - timestamp: now
   - user: A
   - file: the uploaded file id
2. A gets the row back as a positive control. If that fails, the result is `setup` failed and the table is skipped.
3. Checks 7 to 12 run.
4. A archives the test row. If that fails, the result is `cleanup` failed.

Alternative values for check 9: `OTHER_TEXT` (`b@b.co`, `5550199`, `http://b.co`, `10001`, `b`) or `'Changed'`; `false`; `2001-01-01T00:00:00.000Z`; `n+1`, or `n-1` when n+1 would exceed max.

`setup` and `cleanup` are extra result ids that appear only as failures.

Results are saved with `saveCheck(projectId, sha256(JSON(approved_contract)), results, findings)`. Concurrency is limited to one per app (429) and 4 overall (503).

##### 3.12 Receipt (`cloud/src/receipt.ts`)

- Score line: `<passed> of <total> checks passed` plus `, N thing(s) to fix in the code`.
- "All good" (green score) requires all checks passed, findings not null, zero findings, and not stale.
- Stale banner: "The app's rules changed after this check."
- Each check is listed with ✓ or ✕, title, table and detail.
- Code section has three cases:
  - findings null: "The app's code wasn't checked this time..."
  - findings empty: "Nothing found..."
  - otherwise a list of file, line, problem and fix.
- Everything is HTML-escaped. A test passes `<script>` in file names and asserts it is escaped.

##### 3.13 Dockerfile (`cloud/Dockerfile`)

- Base `node:24-alpine`, WORKDIR `/srv`.
- Copies `data/package.json` and the lockfile, then runs `npm ci --omit=dev --ignore-scripts` in `data/`.
- Copies `data/src`, `data/sql`, `cloud/package.json` and `cloud/src`.
- `USER node`, WORKDIR `/srv/cloud`.
- `ENV NODE_ENV=production HOST=0.0.0.0 PORT=8790`, `EXPOSE 8790`, `CMD ["node","src/server.ts"]`. There is no `--env-file`, so env comes from the runtime.

##### 3.14 Code scan (`cloud/src/scan.ts`): runs locally inside the MCP process

Rules (per line, checking every regex match):

| rule id | Trigger |
|---|---|
| `browser_storage` | `localStorage.setItem(`, `sessionStorage.setItem(` or `indexedDB.open(`. A match is exempt when the text right after it starts with a settings key quoted in `'`, `"` or `` ` ``: `theme`, `dark_mode`/`darkmode`, `color_scheme`/`colorscheme`, `lang`, `language`, `locale`, `sidebar*`, `tab`, `active_tab`/`activetab`, `collapsed*`, `consent`, `cookie_consent`/`cookieconsent`, `onboard*`, `seen_*`. Every match is checked, so a harmless setting does not hide a real save on the same line. |
| `other_database` | `from '…'` or `require('…')` of `firebase/(firestore|database)`, `@firebase/(firestore|database)`, `@supabase/supabase-js`, `mongodb`, `mongoose`, `better-sqlite3`, `sqlite`/`sqlite3`, `@prisma/client`, `@vercel/(kv|postgres|blob)`, `@upstash/redis`, `redis`, `ioredis`, `airtable`, `lowdb`, `nedb`, `pouchdb` |
| `local_file_storage` | `writeFileSync`, `writeFile`, `appendFileSync`, `appendFile` or `createWriteStream` with an argument on the same line containing `.json`, `.csv`, `.txt`, `.db`, `.sqlite`, `.sqlite3` or `.ndjson` |
| `basalt_key_in_code` | `\bbsk_[a-z0-9]{10}_[A-Za-z0-9_-]{20,}` |
| `data_file` | A file named `*.db`, `*.sqlite` or `*.sqlite3` anywhere in the walk (line 0) |
| `scan_incomplete` | A code file over 512 KiB (skipped and reported), or more than 2000 files walked (the walk stops and one finding is added) |
| `basalt_folder_not_ignored` | `.basalt/` exists and `.gitignore` has no line equal to `.basalt`, `.basalt/`, `/.basalt` or `/.basalt/` |

- Walk: entries sorted by name. Skipped directories: `node_modules`, `.git`, `.basalt`, `dist`, `build`, `out`, `.next`, `.nuxt`, `.svelte-kit`, `.vercel`, `.cache`, `coverage`, `vendor`.
- Code files: `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.mts`, `.cjs`, `.vue`, `.svelte`, `.astro`, `.html`, `.htm`. `*.min.js` is skipped.
- Each finding is `{rule, file (relative), line (1-based, or 0), problem, fix}`.
- Auth and API code mistakes are explicitly left to `auth_review_code` and `api_review_code` (other blocks).

##### 3.15 Plain-English summary (`cloud/src/summary.ts`)

Each table gets these lines:
- "Each person can see and change only the <t> they added themselves."
- When shared: "The person picked in "<f>" can also see that one, but can't change it."
- "Admins you approve can see and change all of them. Nobody else can see them."
- "Nothing is ever permanently deleted: things can be archived and brought back."

Field descriptions:
- text: "a valid <format>" or "text, up to N characters"
- integer: "a whole number"
- number: "a number"
- boolean: "yes or no"
- timestamp: "a date and time"
- user: "a person using the app"
- plus a range phrase and "(always needed)" for required fields.

**`describeField` has no `file` case**, so a file field renders as `<name>: undefined` (for example in `contract.example.json`'s `photo`).

---

#### 4. MCP server (`cloud/src/mcp.ts`)

Transport and protocol:
- stdio, newline-delimited JSON-RPC 2.0.
- Methods:
  - `initialize` replies with `protocolVersion` (echoes the client's, default `2025-06-18`), `capabilities:{tools:{}}`, `serverInfo:{name:'basalt', version:'0.1.0'}` and an `instructions` string.
  - `ping` replies `{}`.
  - `tools/list` and `tools/call`.
- Messages without `id` (notifications) are ignored.
- Errors:
  - Parse error: `-32700` with id null.
  - Unknown method: `-32601`.
  - Internal error: `-32603`.
  - A tool error replies `{content:[{type:'text', text: message}], isError:true}`.

Local state:
- `${BASALT_PROJECT_DIR || cwd}/.basalt/project.json` holds `{id, name, adminKey, dataUrl}` and is written with mode `0600`.
- `save()` appends `.basalt/` to `.gitignore` unless a line exactly `.basalt/` already exists (it creates `.gitignore` if needed).
- HTTP calls go to `BASALT_URL` with `Bearer <adminKey>`. A non-`ok` reply throws `error.message`.

| Tool | Input schema | Calls | Output |
|---|---|---|---|
| `basalt_start` | `{app_name: string}` (required) | `POST /api/projects {name}`. Refuses if `.basalt/project.json` already exists. | Saves the key and tells Claude to ask plain questions, then call set_rules |
| `basalt_set_rules` | `{rules: object}` (required); the description embeds `CONTRACT_HELP` | `PUT /api/projects/me/rules {contract: rules}` | Either the approve link with why and summary, or "These rules are live now" |
| `basalt_status` | `{}` | `GET /api/projects/me` | Live (rules plus `mapUrl`, and a note when a newer change is pending), waiting, or no rules |
| `basalt_connect_app` | `{}` | `GET /api/projects/me` (must be `live`) | Generated `basalt.js` source plus usage notes |
| `basalt_make_admin` | `{who: string}` (required) | `POST /api/projects/me/admins {who}` | Approve link |
| `basalt_test_login` | `{who: string}` (required) | `POST /api/projects/me/test-login {who}` | `Test login for "<who>" (user id …), good for N minutes:\n<token>` |
| `basalt_check` | `{}` | Runs `scanFolder(DIR)` locally, then `POST /api/projects/me/check {scan}` | `X of Y checks passed`, each failed check, scan findings, receipt URL |

The generated `basalt.js` (`clientCode(dataUrl)`) exports `basalt(getToken)`:
- With no `getToken`, the base is `'/_basalt/data'` with `credentials: 'same-origin'` (cookie). With `getToken`, the base is `dataUrl` with a Bearer token.
- Methods: `get`, `list`, `create`, `update`, `archive`, `restore`, `upload(file)` and `fileUrl(id)`.
- Errors carry `err.code`.

`CONTRACT_HELP` documents for the model: the types, maxLength 1..10000 (default 1000), the 5 formats, min and max, required, the automatic system columns, the shareWith semantics, an example, and that changes are additive-only.

---

#### 5. Cross-cutting facts

- **No delete anywhere.** There is no SQL delete grant or policy, no `delete` op and no route. Archive and restore replace it. Only Cloud's superuser removes data, by deleting the whole DB.
- **No raw SQL.** Table and column names come from `basalt.registry`. Values are bound through `jsonb_populate_record`.
- **Ownership:**
  - `owner_id` defaults to `basalt.uid()` and is not in the insert grant, so callers cannot set it.
  - Mass assignment of `owner_id` or `request_key` is refused both in TS (unknown key) and in SQL (not in `writable`).
  - A shared reader has read access only.
  - Admins can read and update every row.
- **Idempotency key**: per `(owner_id, request_key)`. Another user's identical key does not collide or leak (tested).
- **Cookie/browser path**: hosted apps serve the Data API at `/_basalt/data` on the app origin. The outer Basalt Auth access cookie (`__Host-basalt_at`) carries the data token in claim `bdg`.
- **Token issuer for Cloud apps**: Basalt Auth's per-project HS256 data-token secret and issuer are loaded into `basalt.settings` at DB creation.

---

#### 6. Tests and bench

Counts are calls to `test(` (no `it(` is used). Runner: `node:test`.

| File | Tests | Describes | Needs |
|---|---|---|---|
| `data/test/attacks.test.ts` | 88 | 20 | Local DB (`npm test` resets it), `.env` |
| `data/test/files.test.ts` | 16 | 4 | Local DB |
| `cloud/test/cloud.test.ts` | 30 | 12 | Local DB, in-process Basalt Auth (`../auth` built), `.env` |
| `cloud/test/guard.test.ts` | 11 | 4 | Same |
| `cloud/test/scan.test.ts` | 9 | 1 | Temp dirs only |
| `cloud/test/auth-link.test.ts` | 1 | 0 | Stubbed `fetch` |
| **Total** | **153** | 39 | |

##### 6.1 `data/test/attacks.test.ts` (88)

Setup:
- `migrate(contract.example.json)`.
- Limits raised to 1e6 for the run and reset to 600/60 at the end.
- Users `alice` and `bob` with `userToken`.
- Helpers: `rawApi` (calls `basalt.api` straight from the data login), `refusedByDb` (expects 42501), `awayFromMinuteEdge`.

| Describe | # | Covers |
|---|---|---|
| normal use still works | 3 | Create, read, list and update own rows; paging without repeats; valid formats accepted |
| someone else's data | 3 | get looks not found; list excludes others; update denied |
| forged or broken logins | 13 | No token; wrong secret; `alg:none`; expired; missing exp or iat; lifetime too long; iat in the future; string exp; sha of uid as token; swapped payload; service or admin role claim; non-canonical base64 refused by the DB; alternate spelling of the signature; fractional exp and the all-zero uid; an old transaction outliving its token |
| injection and bad input | 10 | SQL in values, table names and ids; setting owner_id; changing owner_id or id on update; `__proto__` and unknown fields; contract violations; DB enforces formats and limits when the code check is skipped; DB refuses unknown ops and tables; every FORMAT behaves the same in PG and JS; free-form regex contracts refused; page size cap; forged cursor |
| damage limits | 1 | Shared counter across two `BasaltData` instances (limit 30) |
| damage limits stick | 1 | Failed requests count (limit 3) |
| log out everywhere | 1 | `revoke_user` kills existing tokens; new logins work |
| revocation edge cases | 2 | An old snapshot (repeatable read) can't dodge revocation; the cutoff never moves backward |
| idempotent creates | 3 | Same key gives the same row; another user's key doesn't collide; bad keys refused |
| sharing a row | 1 | Assigned staff reads but cannot change; nobody else sees it |
| sharing and paging together | 1 | Own plus shared rows paged once each, newest first |
| filters and sorting | 7 | Equality, range, combined filters, sort both ways plus paging, filters never widen access, bad filters and sorts refused, DB refuses bad filters directly |
| archive instead of delete | 3 | Archive hides and restore brings back; can't archive others' rows; `archived_at` not settable through update |
| the app owner as admin | 2 | Admin sees and changes all rows, including the assignee; data login cannot add an admin |
| audit log | 2 | A missed month's partition is created and rows moved out of default; no-op updates are skipped |
| migrations | 6 | Planted permissive policy removed; adding a required field or removing a field refused atomically; loosening a rule refused; foreign table not taken over; adding an optional field keeps data; field named `constructor` |
| even with the Data service fully taken over | 7 | Raw data login cannot touch tables; cannot read settings, usage, audit, revocations or registry; cannot call anything but the allowed functions; no DDL; cannot skip limits; no large objects, advisory locks, sleep or kill; cannot connect to other DBs |
| the HTTP service app code talks to | 9 | Client end to end; isolation through the client; 401 without login; 404 for unknown routes (raw SQL, delete); oversized and non-JSON bodies; no leaked DB details; bad token refused before the body is read; big pages trimmed but complete; CORS preflight; load shedding |
| tokens from Basalt Auth carry a session id | 3 | A revoked sid stops working at once while other sessions keep working; malformed sid refused; only the platform can call `record_revocations` |
| browser cookie logins on the app's own origin | 4 | Same-origin works; cross-site or no Origin refused; a forged inner token is still checked by the DB; the Authorization header takes precedence |

##### 6.2 `data/test/files.test.ts` (16)

Uses its own contract `jobs {title text required, staff_id user, photo file}` with `shareWith: staff_id`.

| Describe | # | Covers |
|---|---|---|
| uploading and downloading | 4 | PNG round trip byte for byte with safe headers; PDF; client `upload` plus `url`; file name cleaning |
| what gets refused | 6 | HTML posing as an image; SVG, HTML and executables; text with hidden binary; over the size limit; no login; over the quota |
| who can open a file | 5 | Another user can't get a link and made-up links fail; links expire; the shared stylist can open the job photo but nobody else can; can't attach someone else's file; data login can't read files or tickets directly |
| uploads in a browser signed in with Basalt Auth | 1 | With no token, no Authorization header is sent and the cookie is used |

##### 6.3 Cloud tests

`cloud/test/cloud.test.ts` (30; the readiness pass added "deleting an app while something is using its database" and "plain-English rules"). Setup: real Auth via `startAuth`, `Projects.init()`, and the server re-created with `publicUrl` = the actual base URL, with `projectsPerIpPerHour: 1000`.

| Describe | # | Covers |
|---|---|---|
| logins come from Basalt Auth | 3 | Test people are real Auth users and stable per name; tokens from another app or self-signed tokens get 401 (issuer and secret); Auth `revoke-sessions` plus `syncRevocations` gives 401, and re-syncing is harmless |
| a new app | 3 | Own DB `app_<id>` and role `app_<id>_data`; 503 until approved; approve page text; reject leaves `no_rules_yet` and a second decision gets 410; two users isolated |
| changing the rules later | 4 | Optional field is live immediately; new shared table goes to `waiting_for_owner`; removed field gives 409 `field phone was removed`; bad name gives 400 `lowercase letters` |
| the owner as admin | 2 | Admin approval, then the admin sees, assigns staff and archives; a rejected admin request changes nothing |
| the owner's data map | 2 | Map content, PII marking, counts, no values, stable link; wrong key gives 404 |
| many people starting apps at once | 1 | 5 concurrent creates all return 201 |
| apps are walled off from each other | 5 | Cross-DB connection refused; separate Auth projects and secrets; cross-app token gives 401; bad or missing keys give 401; mistyped approval token gives 404; app name is HTML-escaped; secrets stored encrypted (this test asserts on `p.jwtSecret`, which does not exist on `Project`, so that part of the assertion is vacuous) |
| the MCP server Claude Code uses | 1 | Spawns `mcp.ts`; initialize; the 7 tool names in order; `.gitignore` and mode 0600; full start, set_rules, approve, status, connect, test_login, check flow (finds `localStorage.setItem` at `app.js, line 1`); empty tables gives `isError` |
| the hosting platform API | 1 | Wrong key gives 401; `X-Forwarded-For` gives 404; correct key gives 201 |
| hosted environments on the platform API | 6 | Same externalId gives the same DB with a rotated key (the old key gets 401); a burst of 8 gives one DB; a different Auth project gives 409; delete by externalId gives 200 then 404; Guard on a hosted env goes through `selfUrl` with 0 failures; hosted data gets 404 on the public host and reaches the handler (401) on the app host |

`cloud/test/guard.test.ts` (11). Its contract has 3 tables: `bookings` (shared, with formats and ranges), `photos` (required file) and `visits` (integer 1..5).

| Describe | # | Covers |
|---|---|---|
| Guard on a Basalt app | 4 | All 12 check ids present and passing across all 3 tables, with receipt text; leaves zero active rows; 409 without rules, 401 with a bad key, 404 for a receipt with a bad `k`; findings capped at 100 and escaped |
| Guard keeps its receipt honest | 5 | No scan gives "wasn't checked"; rule change marks the receipt stale; a test person named `basalt-check-a` doesn't break the check; a checked app can still be deleted; concurrent checks give [200, 429] |
| Guard on an app that leaks | 1 | Fake permissive server: 9 checks fail (no_login, bad_token, forged_token, expired_token, other_person_get, other_person_list, other_person_update, other_person_archive, fake_owner), including on the second table |
| Guard on an app that is down | 1 | 503 everywhere except the owner's own calls: zero checks pass and the detail says "couldn't tell" |

`cloud/test/scan.test.ts` (9):
- A clean app has no findings.
- Browser storage is flagged with file and line.
- Other data services and local DB libraries are flagged.
- File writes and DB files are flagged.
- A `bsk_` key in code and an un-ignored `.basalt` are flagged.
- `node_modules`, build output and `.git` are skipped.
- A harmless setting does not hide a real save on the same line.
- A file that is too big is reported as `scan_incomplete`.
- A folder with too many files is cut off.

`cloud/test/auth-link.test.ts` (1): a legacy test person (password derived from the plain name) still signs in through the 401 fallback.

##### 6.4 Bench (`data/bench/load.ts`)

- Usage: `node --env-file=.env bench/load.ts [seconds=10] [concurrency=64]`. The README runs `8 16` on a fresh DB.
- Seeds 2000 users × 100 rows = 200,000 rows into `app.bookings` through the admin login, then runs `analyze`.
- Temporarily raises limits to 1e8 per minute and restores the saved values at the end or on an uncaught exception.
- Runs an in-process `createDataServer` with `maxInFlight: 1024` and `BasaltData` with `poolSize: 40`.
- Workload per iteration (random user):
  - 70%: `list limit 20`, and half of those also `get` the first row
  - 20%: `create`
  - 10%: `list limit 1` then `update note`
- Output JSON: `rows_in_table`, `users`, `concurrency`, `seconds`, `operations`, `ops_per_second`, `errors`, `p50_ms`, `p95_ms`, `p99_ms`.
- README result (laptop, 2-CPU Docker VM, 16 concurrent): 775 to 865 ops/s, 0 errors, p50 17 to 19 ms, p99 under 50 ms, 200k to 600k rows.

---

#### 7. Discrepancies and gaps found while reading

1. ~~`data/README.md` says `attacks.test.ts` has 68 tests. It has 88.~~ Fixed in the readiness pass.
2. `uid()` ignores the JWT `kid` and `typ`. There is one HS256 secret per DB and rotation is manual. The only clock skew allowance is 60 s on `iat`.
3. `basalt.settings.max_token_seconds` is never set from Auth's `signing.maxTokenSeconds`. Cloud DBs keep 3600.
4. `cloud.projects.jwt_secret` is written encrypted but never read.
5. `Projects.delete()` drops the DB and roles but not the Basalt Auth project. A failed `#create` drops the DB but not the roles that `01_roles.sql` created (they are cluster-wide).
6. `maxProjects` and the per-IP limit are in-memory only. `projectCount` restarts at 0 and ignores existing projects. Neither is shared across Cloud instances.
7. Approval links have no time-based expiry. Pending admin approvals are never superseded.
8. `basalt.file_fetch` does not consume tickets. Links are reusable for 5 minutes, despite the "one time style" comment.
9. ~~`summary.ts` `describeField` has no `file` branch~~ (fixed in the readiness pass, with a test), so it renders "undefined" for file fields on approval pages and in status text.
10. The `cloud.test.ts` "secrets are stored encrypted" test checks `p.jwtSecret`, which is undefined on `Project`.
11. MCP `save()` only recognizes an exact `.basalt/` line in `.gitignore`, while `scan.ts` accepts 4 spellings. This could append a duplicate entry.
12. Cloud has no route to remove an admin (`basalt.remove_admin` is unused).
13. Data server cookie same-origin check compares Origin to `X-Forwarded-Host` (if present) else `Host`, with no trust-proxy gate in `data/src/server.ts`.

---

## Appendix C: Basalt Host

Exhaustive inventory, checked against the code. Facts changed by the readiness pass (§11) are marked in place.

Scope: `hosting/` in the monorepo. All paths repo-relative. Facts verified against source as of commit `569a411` (branch `hari`).

#### 1. Overview

- Purpose (`hosting/package.json` description): "build, test, stage and ship apps from a single machine, fully driven by coding agents."
- npm workspace root `basalt-hosting` (private). Workspaces: `packages/shared`, `packages/edge`, `packages/egress`, `packages/browser`, `packages/control`, `packages/mcp`.
- `engines.node`: `>=24.7.0`. Dev deps: `@types/node ^26.6.5`, `typescript ^7.0.2`, `vitest ^4.1.12`.
- Root scripts: `build` = `npm run build --workspaces`; `typecheck` = `npm run typecheck --workspaces`; `test` = `npm run test --workspaces --if-present`.
- `hosting/tsconfig.base.json`: target ES2023, module/moduleResolution NodeNext, lib ES2023+DOM, `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `exactOptionalPropertyTypes: false`, `isolatedModules`, `verbatimModuleSyntax`, `declaration`, `sourceMap`, `resolveJsonModule`, `skipLibCheck`.
- `hosting/.gitignore`: `node_modules/`, `dist/`, `*.log`, `.env`, `.env.*` (except `!.env.example`), `.e2e/`.
- Each package: `tsconfig.json` + `tsconfig.build.json` (outDir `dist`, rootDir `src`, types node, lib ES2023/DOM/DOM.Iterable) + `vitest.config.ts` (`include: ['test/**/*.test.ts']`, `testTimeout 60_000`, `hookTimeout 120_000`, `pool: 'forks'`).
- Package scripts (all): `build` = `tsc -p tsconfig.build.json` (control also `&& cp -R src/migrations dist/`), `typecheck` = `tsc -p tsconfig.json --noEmit`, `test` = `vitest run --passWithNoTests`.

##### Packages and dependencies

| Package dir | npm name | Runtime deps |
|---|---|---|
| `hosting/packages/shared` | `@basalt/host-shared` 0.1.0 | none |
| `hosting/packages/edge` | `@basalt/host-edge` 0.1.0 | `@basalt/host-shared`, `undici ^8.12.3` |
| `hosting/packages/egress` | `@basalt/host-egress` 0.1.0 | `@basalt/host-shared` |
| `hosting/packages/browser` | `@basalt/host-browser` 0.1.0 | `@basalt/host-shared`, `playwright ^1.64.1` |
| `hosting/packages/control` | `@basalt/host-control` 0.1.0 | `@basalt/api` (file:`api/packages/framework`), `@basalt/api-mcp` (file:`api/packages/mcp`), `@basalt/auth-mcp` (file:`auth/packages/mcp`), `@basalt/host-shared`, `@hono/node-server ^2.1.5`, `@modelcontextprotocol/sdk ^1.32.2`, `hono ^4.13.13`, `ioredis ^6.0.0`, `pg ^8.23.1`, `tar ^7.5.22`, `undici ^8.12.3`, `zod ^4.6.7`; dev: `@electric-sql/pglite ^0.5.11`, `@types/pg` |
| `hosting/packages/mcp` | `@basalt/host-mcp` 0.1.0 | `@modelcontextprotocol/sdk ^1.32.2`, `ignore ^7.0.14`, `tar ^7.5.22`, `zod ^4.6.7` |

#### 2. Architecture

```
Internet → Cloudflare → cloudflared (10.200.0.250, profile "tunnel") → edge :8080 (public listener)
edge → routes by Host from control's /internal/routes (polled 1 s)
  app host     → static files (basalt-data volume, ro) | /api → backend container :3000 (env network)
               → /_basalt/auth → auth:8787/v1/projects/<projectId>/…
               → /_basalt/data → cloud:8790/p/<dataProjectId>/…
  host.<root>  → control:4000 (public API + /mcp)
  registry.<root> → verdaccio:4873 (GET/HEAD only)
  cloud.<root> → cloud:8790 (if data link configured)
control → Docker socket: builds (basalt_build net), app/migration/e2e containers, per-env networks
backend containers → only egress:3128 for internet; postgres/redis/auth/cloud via env network aliases
browser worker (Chromium) → *.<root> mapped to edge (internal TLS :443); others via egress proxy
local agent → packages/mcp (stdio) → host.<root>/mcp (Streamable HTTP) + /v1/apps/:app/sources
```

##### One line per source file

| File | Lines | Role |
|---|---|---|
| `hosting/packages/shared/src/index.ts` | 5 | Re-exports routes, net, tokens, limiter, log. |
| `hosting/packages/shared/src/routes.ts` | 82 | Edge/control contract types: `EnvKind`, `AppRoute`, `ServiceRoute`, `RouteTable`, `ProtectionSettings`, `CspSettings`, `DEFAULT_PROTECTION`, `EMPTY_CSP`. |
| `hosting/packages/shared/src/net.ts` | 38 | `isNonPublicAddress` (IPv4/IPv6 BlockLists), `ipBucket` (IPv6 → /64), `APP_NAME_RE`. |
| `hosting/packages/shared/src/tokens.ts` | 39 | `signToken`/`verifyToken` (HMAC-SHA256 compact tokens), `hmacHex`, `safeEqual`. |
| `hosting/packages/shared/src/limiter.ts` | 51 | `TokenBuckets` (LRU-bounded token buckets), `Concurrency` (per-key counters). |
| `hosting/packages/shared/src/log.ts` | 26 | JSON line logger with key redaction; `silentLog`. |
| `hosting/packages/edge/src/index.ts` | 4 | Exports `createEdgeHandler`, `ACCESS_COOKIE`, `RouteTableClient`, `Shield`, `normalizePath`, `CLEARANCE_COOKIE`. |
| `hosting/packages/edge/src/main.ts` | 92 | Edge process: public HTTP, internal HTTPS (self-signed), admin listeners; wake callback. |
| `hosting/packages/edge/src/server.ts` | 504 | Request handler: limits, bans, private gate, challenge, auth/data proxy, backend proxy with HMAC signing, static, metrics. |
| `hosting/packages/edge/src/shield.ts` | 118 | Abuse scoring/bans, scanner-path + attack-signature WAF, `normalizePath`. |
| `hosting/packages/edge/src/challenge.ts` | 52 | Proof-of-work challenge issue/verify, clearance cookie, challenge HTML page. |
| `hosting/packages/edge/src/static.ts` | 100 | Static file server: confinement, SPA fallback, ETag, precompressed br/gz, cache headers. |
| `hosting/packages/edge/src/table.ts` | 68 | `RouteTableClient`: polls control `/internal/routes` with If-None-Match, keeps last good table. |
| `hosting/packages/edge/src/metrics.ts` | 72 | Per-host counters, latency histogram, 2-min recent window. |
| `hosting/packages/egress/src/index.ts` | 1 | Exports `createEgressProxy`, `EgressDenied`, `EgressOptions`. |
| `hosting/packages/egress/src/main.ts` | 8 | Starts proxy on `PORT` (default 3128). |
| `hosting/packages/egress/src/proxy.ts` | 148 | Forward proxy (HTTP absolute-form + CONNECT) enforcing public-only, web-ports-only, rate/conn caps. |
| `hosting/packages/browser/src/index.ts` | 1 | Exports `BrowserWorker` and types. |
| `hosting/packages/browser/src/main.ts` | 52 | Internal HTTP API (port 7070) over `BrowserWorker`, bearer + owner header. |
| `hosting/packages/browser/src/worker.ts` | 260 | Playwright Chromium session manager and action executor. |
| `hosting/packages/control/src/main.ts` | 63 | Control process: config, DB migrate, ctx, `Host.recover`, registry publish, janitor (60 s), public :PORT and internal :PORT+1 servers. |
| `hosting/packages/control/src/api.ts` | 85 | Hono apps: public API (workspace token, sources upload, /mcp) and internal API (routes, wake, mail, healthz). |
| `hosting/packages/control/src/admin.ts` | 44 | Operator CLI: `create-workspace <name>`, `under-attack on|off`. |
| `hosting/packages/control/src/config.ts` | 71 | zod env schema with defaults; MASTER_KEY 32-byte check; data link derivation. |
| `hosting/packages/control/src/crypto.ts` | 24 | `SecretBox` (AES-256-GCM + AAD), `sha256`, `id(prefix)`, `secret()`. |
| `hosting/packages/control/src/ctx.ts` | 24 | `Ctx` interface; `authFactory` → `HttpControlPlane(AUTH_INTERNAL_URL, AUTH_PLATFORM_KEY, workspaceId)`. |
| `hosting/packages/control/src/db.ts` | 53 | pg Pool (max 10, statement_timeout 15 s, app name `basalt-control`), `tx`, `migrate` (advisory lock 727455301). |
| `hosting/packages/control/src/docker.ts` | 168 | Minimal Docker Engine API client (v1.47 over unix socket); `hardened()` HostConfig. |
| `hosting/packages/control/src/environments.ts` | 246 | Environment provisioning (network, auth project, DB/Redis, env vars, Cloud data project), capacity, destroy. |
| `hosting/packages/control/src/hosted-platform.ts` | 97 | `HostedPlatform extends LocalPlatform` (api-mcp): encrypted env vars, Redis ACL, backend calls via docker exec. |
| `hosting/packages/control/src/data-link.ts` | 100 | Basalt Cloud client: create/delete data projects, set data rules, `dataUrlFor`. |
| `hosting/packages/control/src/naming.ts` | 19 | `hostFor`, `envKey`, `networkName`, `subnetFor`, `imageTag`, `RESERVED_APP_NAMES`. |
| `hosting/packages/control/src/pipeline.ts` | 297 | CI: extract → scan → detect → install/audit/typecheck/lint/test/build/package in sandbox → static artifacts → COPY-only image. |
| `hosting/packages/control/src/runtime.ts` | 324 | Releases (zero-downtime), migrations, rollback, auto-rollback watch, restart, wake, janitor (sleep/expiry). |
| `hosting/packages/control/src/service.ts` | 520 | `Host` facade: workspaces/tokens, apps, deploy/promote orchestration, secrets/config, logs/metrics, route table, mail, under-attack, recover. |
| `hosting/packages/control/src/testing.ts` | 251 | Smoke tests via internal edge, e2e Playwright sandbox, test users, access tokens/share links, captured emails. |
| `hosting/packages/control/src/sources.ts` | 68 | Upload storage (sha256-addressed .tgz) and defensive extraction. |
| `hosting/packages/control/src/scanner.ts` | 62 | Hardcoded-secret regexes + `reviewApiCode` (api-mcp) static review. |
| `hosting/packages/control/src/registry.ts` | 50 | Publishes bundled `@basalt/*` tarballs to Verdaccio. |
| `hosting/packages/control/src/guides.ts` | 114 | `host_guide` topic texts: workflow, project, testing, operations, security. |
| `hosting/packages/control/src/mcp.ts` | 231 | Remote MCP server (43 host/browser tools + 6 auth/api tools). |
| `hosting/packages/control/src/migrations/001_init.sql` | 133 | Control-plane schema. |
| `hosting/packages/control/src/migrations/002_data_projects.sql` | 3 | Adds `data_project_id`, `data_admin_key_enc` to environments. |
| `hosting/packages/mcp/src/index.ts` | 2 | Exports `packProject`, `listProjectFiles`, `initProject`. |
| `hosting/packages/mcp/src/main.ts` | 85 | Local stdio MCP: `host_deploy`, `host_init` local; proxies all other tools to remote `/mcp`. |
| `hosting/packages/mcp/src/pack.ts` | 40 | Project file listing (gitignore + fixed exclusions) and gzip tar packing (≤50 MB). |
| `hosting/packages/mcp/src/init.ts` | 55 | Writes `.npmrc`, `basalt.json`, `playwright.config.ts`, `e2e/home.spec.ts`, `.gitignore` entries. |
| `hosting/images/runtime/Dockerfile` | 14 | Base image `basalt/runtime:1` for user backends. |
| `hosting/images/runtime/migrate.mjs` | 49 | In-container SQL migration runner with RLS-weakening guard. |
| `hosting/images/runtime/package.json` | 1 | `basalt-runtime-tools`, dep `pg 8.23.1`. |
| `hosting/Dockerfile` | 68 | Multi-stage build of control/edge/egress/browser images. |
| `hosting/deploy/docker-compose.yml` | 199 | Whole platform on one machine. |
| `hosting/deploy/docker-compose.local.yml` | 19 | Loopback ports for local testing. |
| `hosting/deploy/setup.sh` | 58 | One-time setup: `.env` generation, image builds, compose up. |
| `hosting/deploy/postgres/init.sh` | 9 | Creates `basalt_host`, `basalt_auth` DBs; revokes PUBLIC. |
| `hosting/deploy/verdaccio/config.yaml` | 32 | Platform npm registry config. |
| `hosting/scripts/pack-basalt.mjs` | 31 | Packs publishable `@basalt/*` packages for the registry. |
| `hosting/scripts/e2e-platform.mjs` | 349 | Full platform E2E via the real local MCP client. |

#### 3. Docker images

##### `hosting/Dockerfile` (build context = repo root; `# syntax=docker/dockerfile:1.7`)

- Stage `build` (`node:24-alpine`, WORKDIR `/src`):
  - Copies package manifests then `npm ci --ignore-scripts` for `auth/`, `api/`, `hosting/` (hosting with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`).
  - Copies `auth/packages`, `api/packages`, `hosting/packages`, `hosting/scripts`.
  - `tsc -p` build of auth `sdk`, `mcp`; api `framework`, `mcp`; hosting `shared edge egress browser control mcp`.
  - `cp -R packages/control/src/migrations packages/control/dist/`.
  - `node scripts/pack-basalt.mjs /src /out/packages`.
  - Removes `node_modules/.cache`, and `/src/*/packages/*/src`, `/src/*/packages/*/test`.
- Stage `control` (`node:24-alpine`): `apk add tini`; copies `/src` and `/out/packages` → `/opt/basalt/packages`; WORKDIR `/src/hosting/packages/control`; `NODE_ENV=production`; runs as root (comment: needs Docker socket; executes no user code); `ENTRYPOINT ["/sbin/tini","--"]`, `CMD ["node","dist/main.js"]`.
- Stage `edge` (`node:24-alpine`): `apk add tini openssl`, `mkdir /tls && chown node:node /tls`; copies `/src`; WORKDIR `/src/hosting/packages/edge`; `USER node`; tini; `node dist/main.js`.
- Stage `egress` (`node:24-alpine`): tini; copies only `/src/hosting`; WORKDIR `.../egress`; `USER node`; `node dist/main.js`. (No `NODE_ENV` set.)
- Stage `browser` (`mcr.microsoft.com/playwright:v1.64.1-noble`): copies `/src/hosting`; WORKDIR `.../browser`; `NODE_ENV=production`; `USER pwuser`; `CMD ["node","dist/main.js"]` (no tini).

##### `hosting/images/runtime/Dockerfile` (tag `basalt/runtime:1`, built by setup.sh)

- Stage `deps` (`node:24-alpine`): `/opt/basalt`, `npm install --omit=dev --ignore-scripts --no-audit --no-fund` (installs `pg 8.23.1`).
- Final (`node:24-alpine`): creates group/user `app` uid/gid 10001; removes npm, npx, yarn binaries; copies `node_modules`, `migrate.mjs`, `package.json` to `/opt/basalt/`; `NODE_ENV=production`; `USER 10001:10001`; WORKDIR `/app`.
- User app images layered on top with COPY only (see §6.6).

##### `hosting/images/runtime/migrate.mjs`

- Applies `/app/db/migrations/*.sql` (arg 1 overrides dir); files filtered by `/^\d+.*\.sql$/`, sorted.
- Connects with `DATABASE_ADMIN_URL`. Creates `basalt_schema_migrations(name text PK, applied_at timestamptz)`. Takes `pg_advisory_lock(727455101)`.
- Each unapplied file: forbidden-pattern check, then `BEGIN` / SQL / insert name / `COMMIT` (ROLLBACK on error → throws `<f> failed: …`).
- Forbidden SQL (refuses to apply):

| Regex | Reason |
|---|---|
| `DISABLE\s+ROW\s+LEVEL\s+SECURITY` | disables row-level security |
| `NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY` | stops forcing row-level security |
| `\bBYPASSRLS\b` | grants BYPASSRLS |
| `DROP\s+POLICY[^;]*basalt_owner` | drops the Basalt ownership policy |
| `\bbasalt_auth\.keys\b` | touches the data-grant key table |
| `\bSUPERUSER\b` | grants superuser |

- After: `SELECT * FROM basalt_auth.unprotected_tables()` (errors ignored); if rows → prints `WARNING unprotected per-user tables: t(col)…`, exit code 2.
- Exit codes: 0 ok, 1 error, 2 applied with warnings (control treats 0 and 2 as success).

#### 4. Deploy (`hosting/deploy/`)

##### 4.1 `docker-compose.yml` (project `name: basalt`)

- Header: ingress ONLY via Cloudflare Tunnel (profile `tunnel`); no ports published.
- Anchor `x-hardening` applied to every service: `security_opt: ["no-new-privileges:true"]`, `restart: unless-stopped`, logging `json-file` `max-size 20m`, `max-file 5`.

| Service | Image / build | container_name | Networks (aliases) | Volumes | Extra hardening / limits |
|---|---|---|---|---|---|
| postgres | `postgres:17-alpine` | basalt-postgres | core | `pgdata:/var/lib/postgresql/data`, `./postgres/init.sh:/docker-entrypoint-initdb.d/init.sh:ro` | command `postgres -c max_connections=400 -c shared_buffers=512MB -c password_encryption=scram-sha-256` |
| redis | `redis:7-alpine` | basalt-redis | core | `redisdata:/data` | command: creates `/data/users.acl` (`user default on >$REDIS_PASSWORD ~* &* +@all`) if missing, then `redis-server --aclfile /data/users.acl --appendonly yes --maxmemory 512mb --maxmemory-policy volatile-lru` |
| verdaccio | `verdaccio/verdaccio:6` | basalt-verdaccio | core; build (alias `verdaccio`); outbound | `./verdaccio/config.yaml:/verdaccio/conf/config.yaml:ro`, `verdaccio:/verdaccio/storage` | — |
| auth | build `../../auth` → `basalt/auth:local` | basalt-auth | core | — | depends_on postgres, redis healthy |
| cloud | build ctx `../..`, `cloud/Dockerfile` → `basalt/cloud:local` | basalt-cloud | core (alias `cloud`) | — | `read_only: true`, `cap_drop: [ALL]`; depends_on postgres healthy, auth started |
| control | build ctx `../..`, `hosting/Dockerfile` target `control` → `basalt/control:local` | basalt-control | core (alias `control`); outbound | `basalt-data:/data`, `/var/run/docker.sock:/var/run/docker.sock` | depends_on postgres/redis healthy, auth/cloud started |
| edge | target `edge` → `basalt/edge:local` | basalt-edge | core (alias `edge`) | `basalt-data:/data:ro`, `edge-tls:/tls` | `read_only: true`, `cap_drop: [ALL]`, `sysctls net.ipv4.ip_unprivileged_port_start: "0"`; depends_on control |
| egress | target `egress` → `basalt/egress:local` | basalt-egress | core (alias `egress`); outbound | — | `read_only: true`, `cap_drop: [ALL]` |
| browser | target `browser` → `basalt/browser:local` | basalt-browser | core (alias `browser`) | — | `shm_size: 512m`, `mem_limit: 2g` |
| cloudflared | `cloudflare/cloudflared:2025.10.0` | basalt-cloudflared | core (`ipv4_address: 10.200.0.250`); outbound | — | `profiles: [tunnel]`; command `tunnel --no-autoupdate run` |

- Healthchecks: postgres `pg_isready -U postgres` (interval 5s, retries 20); redis `redis-cli -a $REDIS_PASSWORD --no-auth-warning ping` (interval 5s, retries 20); auth (image HEALTHCHECK, `/healthz`); **cloud** `wget -qO- http://127.0.0.1:8790/healthz` (10s/3s/6); **control** `wget -qO- http://127.0.0.1:4000/v1/health` (10s/3s/6, start_period 30s); **edge** `node -e fetch('http://127.0.0.1:8080/')` (any HTTP answer; 10s/3s/6). Bold ones added in the readiness pass.
- Start order (readiness pass): cloud waits for postgres healthy + **auth healthy**; control waits for postgres, redis, auth and cloud **healthy**; edge waits for control **healthy**.
- `user:` not set on any compose service (image USER applies: edge/egress `node`, browser `pwuser`, control root).

Networks:

| Key | Docker name | internal | Subnet |
|---|---|---|---|
| core | `basalt_core` (project-prefixed) | true | 10.200.0.0/24 |
| build | `basalt_build` (explicit `name`) | true | 10.200.1.0/24 |
| outbound | `basalt_outbound` | false (default) | default IPAM |

Volumes: `pgdata`, `redisdata`, `verdaccio`, `edge-tls`, `basalt-data` (explicit `name: basalt-data`).

Environment variables per service:

- postgres: `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`.
- redis: `REDIS_PASSWORD=${REDIS_PASSWORD}`.
- auth: `NODE_ENV=production`, `PUBLIC_URL=https://auth.${ROOT_DOMAIN}`, `DATABASE_URL=postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/basalt_auth`, `REDIS_URL=redis://default:${REDIS_PASSWORD}@redis:6379`, `BASALT_AUTH_MASTER_KEY=${AUTH_MASTER_KEY}`, `BASALT_AUTH_PLATFORM_KEY=${AUTH_PLATFORM_KEY}`, `TRUST_PROXY_HOPS=1`, `COOKIE_SECURE=true`, `MAILER=webhook`, `MAIL_WEBHOOK_URL=http://control:4001/internal/mail`, `MAIL_WEBHOOK_SECRET`.
- cloud: `CLOUD_ADMIN_URL=postgres://postgres:…@postgres:5432/postgres`, `CLOUD_DB_HOST=postgres:5432`, `CLOUD_MASTER_KEY`, `CLOUD_PLATFORM_KEY`, `AUTH_URL=http://auth:8787`, `AUTH_PLATFORM_KEY`, `PUBLIC_URL=https://cloud.${ROOT_DOMAIN}`, `TRUST_PROXY=1`.
- control: `ROOT_DOMAIN`, `DATABASE_URL=…/basalt_host`, `PG_ADMIN_URL=…/postgres`, `REDIS_ADMIN_URL=redis://default:${REDIS_PASSWORD}@redis:6379`, `AUTH_PUBLIC_URL=https://auth.${ROOT_DOMAIN}`, `AUTH_PLATFORM_KEY`, `MASTER_KEY=${HOST_MASTER_KEY}`, `INTERNAL_TOKEN`, `MAIL_WEBHOOK_SECRET`, `REGISTRY_PUBLISH_PASSWORD`, `RESEND_API_KEY=${RESEND_API_KEY:-}`, `MAIL_FROM=${MAIL_FROM:-no-reply@${ROOT_DOMAIN}}`, `DATA_VOLUME=basalt-data`, `BUILD_NETWORK=basalt_build`, `CLOUD_INTERNAL_URL=http://cloud:8790`, `CLOUD_PLATFORM_KEY`, `INFRA_CONTAINERS=basalt-postgres,basalt-redis,basalt-auth,basalt-edge,basalt-egress,basalt-cloud`.
- edge: `CONTROL_URL=http://control:4001`, `INTERNAL_TOKEN`, `EDGE_KEY`, `AUTH_INTERNAL_URL=http://auth:8787`, `TRUSTED_PROXIES=10.200.0.250`, `INTERNAL_TLS_PORT=443`, `TLS_DIR=/tls`.
- egress: none.
- browser: `INTERNAL_TOKEN`, `ROOT_DOMAIN`, `EDGE_HOST=edge`, `EGRESS_PROXY=http://egress:3128`.
- cloudflared: `TUNNEL_TOKEN=${CF_TUNNEL_TOKEN}`.

Service ports (in-container, none published in base file): postgres 5432, redis 6379, verdaccio 4873, auth 8787, cloud 8790, control 4000 (public API) + 4001 (internal API), edge 8080 (public HTTP) + 443 (internal TLS) + 9090 (admin), egress 3128, browser 7070.

##### 4.2 `docker-compose.local.yml` (overlay)

- edge: `ports: ["127.0.0.1:8080:8080", "[::1]:8080:8080"]` (IPv6 loopback added in the readiness pass: `*.localhost` resolves to `::1` first), `TRUSTED_PROXIES: ""`, `PUBLIC_SCHEME=http`, `PUBLIC_PORT=8080`, adds network `outbound`.
- control: `ports: ["127.0.0.1:4000:4000"]`, `BUILD_MEMORY_MB=1024`, `TEST_MEMORY_MB=1024`, `MAX_CONCURRENT_BUILDS=1` (comment: 4 GB dev VM), `PUBLIC_SCHEME=http`, `PUBLIC_PORT=8080`, `HOST_PUBLIC_URL=http://127.0.0.1:4000`, `REGISTRY_PUBLIC_URL=http://registry.${ROOT_DOMAIN}:8080/`.
- cloud: `PUBLIC_URL: http://cloud.${ROOT_DOMAIN}:8080`.

##### 4.3 `setup.sh`

- Usage: `./setup.sh <root-domain> [--tunnel <token> | --local]`; `set -euo pipefail`; cds to script dir.
- `--local` adds `-f docker-compose.local.yml`.
- If `.env` missing: `umask 077`, writes: `ROOT_DOMAIN`, `POSTGRES_PASSWORD`(hex32), `REDIS_PASSWORD`(hex), `AUTH_MASTER_KEY`(base64 32), `AUTH_PLATFORM_KEY`(hex), `HOST_MASTER_KEY`(base64 32), `INTERNAL_TOKEN`(hex), `MAIL_WEBHOOK_SECRET`(hex), `EDGE_KEY`(hex), `REGISTRY_PUBLISH_PASSWORD`(hex), `CLOUD_MASTER_KEY`(hex), `CLOUD_PLATFORM_KEY`(hex), `CF_TUNNEL_TOKEN`, `RESEND_API_KEY=` (empty). `rand()` = `openssl rand -base64 32`; `hex()` = `openssl rand -hex 32`.
- Upgrade path: appends `CLOUD_MASTER_KEY`, `CLOUD_PLATFORM_KEY` if absent.
- Builds `basalt/runtime:1` from `../images/runtime`; `docker pull mcr.microsoft.com/playwright:v1.64.1-noble`; `compose build`.
- Local: `up -d --wait --wait-timeout 300` (readiness pass; tunnel and no-tunnel paths also `--wait`), prints apps at `http://<app>.<root>:8080`, owner pages `http://cloud.<root>:8080`, control API `http://127.0.0.1:4000`.
- Tunnel token present: `docker compose --profile tunnel up -d`; else `docker compose up -d` (no public ingress).
- Ends with: `docker exec basalt-control node dist/admin.js create-workspace <name>`.

##### 4.4 `postgres/init.sh`

- `CREATE DATABASE basalt_host; CREATE DATABASE basalt_auth;` then `REVOKE ALL ON DATABASE postgres|basalt_host|basalt_auth FROM PUBLIC`.

##### 4.5 `verdaccio/config.yaml`

- storage `/verdaccio/storage/data`; htpasswd `/verdaccio/storage/htpasswd`, `max_users: 1`.
- uplink `npmjs` → `https://registry.npmjs.org/`, timeout 30s, maxage 10m.
- `@basalt/*`: access `$all`, publish/unpublish `basalt-platform`, NO proxy (dependency-confusion protection).
- `**`: access `$all`, publish/unpublish `basalt-platform`, proxy npmjs.
- audit middleware enabled; web UI disabled; keepAliveTimeout 60; listen `0.0.0.0:4873`; log stdout json level warn.

#### 5. Shared library (`hosting/packages/shared`)

- `TokenBuckets(maxKeys=200_000)`: `take(key, perMinute, burst=max(10, ceil(perMinute/6)))`; refills `perMinute` per 60 s; LRU eviction (Map re-insert); denied → `retryAfter = max(1, ceil((1-tokens)*60/perMinute))` s.
- `Concurrency`: `acquire(key,max)`, `release`, `get`.
- Logger: JSON `{level,time,service,msg,...}`; warn/error → stderr; `LOG_LEVEL` env (default info); redacts keys matching `/pass(word)?|secret|token|authorization|cookie|grant|key$/i`; Errors → `{message,stack}`.
- `isNonPublicAddress` blocks IPv4: 0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4. IPv6: ::/128, ::1/128, 64:ff9b::/96, 64:ff9b:1::/48, 100::/64, 2001::/23, 2001:db8::/32, 2002::/16, fc00::/7, fe80::/10, fec0::/10, ff00::/8; plus any `::ffff:` mapped or `::a.b.c.d`; non-IP strings → true.
- `ipBucket`: `::ffff:a.b.c.d` → v4; IPv4 as-is; IPv6 → first 4 groups `xxxx:xxxx:xxxx:xxxx::/64`.
- `APP_NAME_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/` (3–32 chars).
- Tokens: `base64url(JSON payload).base64url(HMAC-SHA256(key, body))`; verify rejects >2048 chars, bad MAC (timing-safe), missing/expired `exp` (unix s).
- `DEFAULT_PROTECTION`: `perIpPerMinute 600`, `maxConcurrency 64`, `underAttack false`, `maxBodyBytes 10 MiB`.
- `AppRoute` fields: kind 'app', host, app, envId, env, projectId, edgeSecret, staticDir|null, backend|null, sleeping, accessKey|null, protection, csp, dataUrl|null. `ServiceRoute`: kind 'service', host, upstream, methods[], perIpPerMinute. `RouteTable`: version, generatedAt, underAttack, routes.

#### 6. Control plane (`hosting/packages/control`)

##### 6.1 Config env vars (`src/config.ts`, zod)

| Var | Default / constraint | Meaning |
|---|---|---|
| NODE_ENV | `production` (enum development/test/production) | |
| PORT | 4000 | Public API; internal API = PORT+1 |
| ROOT_DOMAIN | required, `/^([a-z0-9-]+\.)+[a-z]{2,}$/` | apps at `<app>.<root>` |
| DATABASE_URL | required | control-plane DB |
| PG_ADMIN_URL | required | superuser for per-env DBs/roles |
| REDIS_ADMIN_URL | required | creates ACL users |
| REDIS_HOST | `redis:6379` | host:port in app REDIS_URL |
| AUTH_INTERNAL_URL | `http://auth:8787` | |
| AUTH_PUBLIC_URL | required URL | issuer |
| AUTH_PLATFORM_KEY | required, min 32 | |
| MASTER_KEY | required, min 40 chars; must decode (base64) to 32 bytes | SecretBox key |
| INTERNAL_TOKEN | required, min 32 | edge/browser internal calls |
| MAIL_WEBHOOK_SECRET | required, min 32 | |
| RESEND_API_KEY | optional | production email delivery |
| MAIL_FROM | `no-reply@example.com` | |
| DATA_DIR | `/data` | |
| DATA_VOLUME | `basalt-data` | volume mounted into build/test containers via Subpath |
| DOCKER_SOCKET | `/var/run/docker.sock` | |
| REGISTRY_URL | `http://verdaccio:4873/` | |
| EGRESS_PROXY | `http://egress:3128` | |
| BROWSER_URL | `http://browser:7070` | |
| EDGE_ADMIN_URL | `http://edge:9090` | |
| INFRA_CONTAINERS | `basalt-postgres,basalt-redis,basalt-auth,basalt-edge,basalt-egress,basalt-cloud` (cloud added to the default in the readiness pass) | joined to every env network |
| EDGE_CONTAINER | `basalt-edge` | |
| BUILD_NETWORK | `basalt_build` (default fixed in the readiness pass; was `basalt-build`) | |
| RUNTIME_IMAGE | `basalt/runtime:1` | |
| BUILD_IMAGE | `node:24-alpine` | |
| TEST_IMAGE | `mcr.microsoft.com/playwright:v1.64.1-noble` | |
| MAX_RUNNING_APPS | 40 | max environments not 'deleting' |
| MAX_PREVIEWS_PER_APP | 3 | |
| MAX_CONCURRENT_BUILDS | 2 | |
| PREVIEW_TTL_HOURS | 24 | |
| SLEEP_AFTER_MINUTES | 30 | |
| APP_MEMORY_MB | 256 | preview/staging backends |
| PRODUCTION_MEMORY_MB | 512 | |
| BUILD_MEMORY_MB | 1536 | |
| TEST_MEMORY_MB | 1536 | |
| BUILD_TIMEOUT_MINUTES | 15 | whole build deadline |
| CLOUD_INTERNAL_URL | optional URL | Basalt Cloud; must be set together with CLOUD_PLATFORM_KEY |
| CLOUD_PLATFORM_KEY | optional, min 32 | |
| PUBLIC_SCHEME | `https` (`https`/`http`) | readiness pass: scheme of URLs shown to people and of Auth allowed origins (`appUrl()`) |
| PUBLIC_PORT | none (1–65535) | readiness pass: port appended by `appUrl()` (demo: 8080) |
| HOST_PUBLIC_URL | `https://host.<ROOT_DOMAIN>` | readiness pass: control URL printed for the connector |
| REGISTRY_PUBLIC_URL | `https://registry.<ROOT_DOMAIN>/` | readiness pass: registry printed for the connector, `.npmrc` and the project guide |

- Other env read directly: `REGISTRY_PUBLISH_PASSWORD` (registry.ts), `BASALT_PACKAGES_DIR` (default `/opt/basalt/packages`), `LOG_LEVEL`.
- Derived: `masterKey` Buffer, `dataLink = {url, platformKey} | null`, `infraContainers[]`.

##### 6.2 HTTP routes

Public API (`createPublicApi`, Hono, port PORT=4000; reached via edge as `host.<root>`):

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/health` | none | `{ok:true}` |
| POST | `/v1/apps/:app/sources` | workspace token | Upload gzipped tarball (bodyLimit 50 MB → 413 "Upload too large (max 50 MB)."); returns 201 `{sourceId: sha256, size}` |
| ALL | `/mcp` | workspace token | Stateless MCP Streamable HTTP (`sessionIdGenerator: undefined`, `enableJsonResponse: true`); new server per request bound to workspace |

- Auth middleware on `/v1/apps/*` and `/mcp`: `Authorization: Bearer bht_…` → `host.authenticate`; 401 `Invalid or missing workspace token.`; rate limit 1200/min per workspace (TokenBuckets) → 429 with `retry-after`.
- Errors: `UserError` → its status; `CapacityError` → 503; else 500 `Internal error.` (logged).

Internal API (`createInternalApi`, port PORT+1=4001, platform network only):

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/internal/routes` | Bearer INTERNAL_TOKEN | Route table; `If-None-Match` == current version → 304 |
| POST | `/internal/wake` | Bearer INTERNAL_TOKEN | `{envId}` (must match `/^env_[a-z0-9]+$/`, else 400); fire-and-forget `host.wake`; 202 |
| POST | `/internal/mail` | exempt from bearer; HMAC `basalt-signature` header | Auth-service mail webhook → `handleMail` |
| GET | `/healthz` | none | `{ok:true}` |

Edge admin API (edge `:9090`, Bearer INTERNAL_TOKEN): `GET /metrics`, `GET /bans`, `DELETE /bans?ip=`, `POST /reload` (returns `{version}`); else 404.
Browser API (`:7070`): see §9.

##### 6.3 Database schema (`src/migrations`)

Migration runner: `host_schema_migrations(name PK, applied_at)`; whole run in one transaction under `pg_advisory_xact_lock(727455301)`; files `*.sql` sorted.

| Table | Columns |
|---|---|
| workspaces | id text PK, name text NN, created_at timestamptz default now() |
| api_tokens | id PK, workspace_id → workspaces ON DELETE CASCADE, token_hash bytea NN UNIQUE, name NN, created_at, last_used_at, revoked_at |
| apps | id PK, workspace_id → workspaces CASCADE, name NN UNIQUE (global), created_at |
| environments | id PK, app_id → apps CASCADE, kind CHECK in (preview, staging, production), slug NN, host NN UNIQUE, status default 'provisioning', subnet_index int NN UNIQUE, auth_project_id, current_release_id, sleeping bool default false, protection jsonb default '{}', csp jsonb default '{}', access_key_enc bytea, error, created_at, expires_at, last_active_at NN default now(), UNIQUE(app_id, slug); +002: data_project_id text, data_admin_key_enc bytea |
| env_vars | env_id → environments CASCADE, name, value_enc bytea NN, secret bool NN, managed bool NN, updated_at; PK(env_id, name) |
| deployments | id PK, app_id → apps CASCADE, source_sha NN, message, status default 'queued', steps jsonb default '[]', manifest jsonb, image, static_dir, error, created_at, finished_at; index (app_id, created_at DESC) |
| releases | id PK, env_id → environments CASCADE, deployment_id → deployments CASCADE, status default 'starting', container, reason, created_at, live_at, ended_at; index (env_id, created_at DESC) |
| test_runs | id PK, env_id → env CASCADE, deployment_id → deployments CASCADE, kind NN, status default 'running', summary jsonb default '{}', created_at, finished_at; index (env_id, created_at DESC) |
| pipelines | id PK, app_id → apps CASCADE, deployment_id → deployments CASCADE, target NN, status default 'running', stage default 'build', log jsonb default '[]', created_at, finished_at |
| emails | id bigserial PK, env_id → env CASCADE, to_addr, subject, body (all NN), created_at; index (env_id, id DESC) |
| audit | id bigserial PK, workspace_id, action NN, target, data jsonb default '{}', created_at; index (workspace_id, id DESC) |
| platform_settings | key text PK, value jsonb NN (used: `under_attack`) |

Status values used in code:
- environments.status: provisioning → ready | failed; deleting.
- deployments.status: queued → building → built | failed.
- releases.status: starting → live → superseded | rolled_back; failed.
- pipelines.status: running → passed | failed; stage: build, preview, staging, production, done, error.
- test_runs.status: running → passed | failed | error; kind smoke | e2e.
- Audit actions: `app.created`, `app.deleted`, `deploy.started`, `promote`, `secret.set`, `secret.deleted`, `data_rules.updated`, `api_config.updated`, `protection.updated`.

##### 6.4 IDs, naming, environment model

- `id(prefix)` = `<prefix>_` + 9 random bytes base64url with `-`/`_` → `x`, lowercased. Prefixes: `ws`, `tok`, `app`, `env`, `dep`, `pl`, `rel`, `run`, `e2e`.
- Environment kinds: `preview`, `staging`, `production`.
- Slugs: production `prod`; staging `staging`; preview `p` + last 6 chars of deployment id.
- Hosts (`hostFor`, single DNS label for one wildcard cert): production `<app>.<root>`; staging `<app>--staging.<root>`; preview `<app>--<slug>.<root>`.
- Env names accepted by tools: `production` → slug `prod`; others matched by slug.
- `envKey = <app>-<slug>`; per-env database `basalt_<envKey with - → _>`, roles `<db>_app`, `<db>_admin` (created by reused `LocalPlatform`/`setupApp` from `@basalt/api-mcp`; dropped in destroy).
- Network `basalt-env-<envId>`, subnet `10.201.<subnet_index>.0/24`; index = lowest unused integer (under `pg_advisory_xact_lock(727455302)`); `> 250` → CapacityError "No free environment networks left on this machine."
- Env network: bridge, `Internal: true`, label `basalt.env=<envId>`, option `com.docker.network.bridge.enable_icc=true`; infra containers connected with aliases: basalt-postgres→`postgres`, basalt-redis→`redis`, basalt-auth→`auth`, basalt-edge→`edge`, basalt-egress→`egress`, basalt-cloud→`cloud`.
- Image tag: `basalt-app/<app>:<deploymentId>`.
- App names: `APP_NAME_RE`, no `--`, not reserved. Reserved: www, api, auth, host, registry, admin, mail, status, app, edge, internal, staging, preview, static, cdn, cloud. Name globally unique; same-workspace create is idempotent; other workspace → 409 "taken".
- Capacity (`assertCapacity` on new env): count of environments with status ≠ deleting ≥ MAX_RUNNING_APPS → CapacityError. For previews: destroys oldest previews so that after creation ≤ MAX_PREVIEWS_PER_APP.
- Preview `expires_at` = now + PREVIEW_TTL_HOURS; staging/production null.
- Access key: non-production envs get `secret()` (32 random bytes base64url) sealed with AAD `access:<envId>`; production `access_key_enc = NULL` (public).

##### 6.5 Environment provisioning (`Environments.ensure`)

1. Return if existing env status `ready`. Else insert row (capacity check, subnet allocation).
2. `ensureNetwork` (create if missing; connect infra containers).
3. `setupApp({platform: HostedPlatform, auth: authFor(workspace)}, {app: envKey, name: app.name, origins: ['https://<host>']})` from `@basalt/api-mcp` → creates hosted auth project (one auth "owner" = workspace id), DB/roles, Redis user (`ensureRedis`), etc.; returns `projectId`.
4. `restrictRedis(projectId)`.
5. Managed env vars written: `BASALT_AUTH_URL`=AUTH_PUBLIC_URL, `BASALT_AUTH_INTERNAL_URL`=AUTH_INTERNAL_URL, `HTTPS_PROXY`/`HTTP_PROXY`=EGRESS_PROXY, `NO_PROXY=auth,cloud,postgres,redis,localhost,127.0.0.1`, `NODE_USE_ENV_PROXY=1`, `NODE_ENV=production`, `PORT=3000`, `DATABASE_MAX_CONNECTIONS=5`, `BASALT_ENVIRONMENT=<kind>`, `BASALT_APP_HOST=<host>` (all `secret:false`, managed).
6. If data link: under `pg_advisory_xact_lock(hashtext('data:<envId>'))`, reuse recorded project only if `auth_project_id === projectId`; else `createDataProject` (name `<app> (<slug>)`, authProjectId, authOwner = workspace, externalId = envId); store `data_project_id`, `data_admin_key_enc` (AAD `data:<envId>`); write `BASALT_DATA_URL` = `<cloud>/p/<projectId>`.
7. `status='ready'`, `auth_project_id`, `error=NULL`; `routes.bump()`. On any error: `status='failed'`, `error` (≤1000 chars), rethrow.

Other managed vars come from `setupApp`/LocalPlatform (e.g. `DATABASE_URL`, `DATABASE_ADMIN_URL`, `REDIS_URL`, `BASALT_EDGE_SECRET`, `BASALT_API_CONFIG`); route table requires `BASALT_EDGE_SECRET` and `auth_project_id` to publish a route.

`HostedPlatform` (extends `LocalPlatform` with `pgAdminUrl: PG_ADMIN_URL, redisUrl: '', stateDir: '/tmp/basalt-unused'`):
- `describe()` → `Basalt Host (<root>)`; every method checks `app === envKey` else throws.
- `readEnv`/`writeEnv`: `env_vars` rows, value sealed AAD `env:<envId>:<NAME>`; names `/^[A-Z][A-Z0-9_]*$/`; `null` deletes; `managed` default true (user secrets written with false).
- `ensureRedis`: user `u_<envId>`, password 24 random bytes b64url; `ACL SETUSER … reset on >pw resetkeys resetchannels -@all +ping`; `ACL SAVE`; `REDIS_URL=redis://u_<envId>:<pw>@<REDIS_HOST>` (secret).
- `restrictRedis`: `ACL SETUSER u_<envId> resetkeys ~bapi:<projectId>:* -@all +ping +info +hello +auth +select +client|setname +client|setinfo +get +set +del +incr +pexpire +expire +eval +evalsha +script|load`; `ACL SAVE`.
- `configureEdge` → `routes.bump()`. `applyChanges` → restart live release if any ("Rolled out to the running release.") else "Takes effect on the next deploy".
- `callBackend(path)`: signs with `signEdgeRequest(BASALT_EDGE_SECRET, {method:'GET', pathAndQuery, requestId:'ctl-<hex16>'})` (from `@basalt/api`), runs `wget -qO- --header x-request-id --header basalt-edge-signature http://127.0.0.1:3000<path>` via docker exec in live container; status 200 if exit 0 else 502.

##### 6.6 Deploy pipeline (`service.ts` + `pipeline.ts`)

Entry: `POST /v1/apps/:app/sources` (store) → MCP `host_deploy_source` → `Host.deploy(ws, app, sha, {message, target})`.
- `sourceSha` must be `/^[0-9a-f]{64}$/`; source path `<DATA_DIR>/sources/<sha>.tgz`.
- Inserts `deployments` (message ≤500 chars) + `pipelines` (target `preview` | `production`); audit `deploy.started`; runs asynchronously.

`runPipeline` stages:
1. `build` → `Pipeline.build`; if status ≠ built → pipeline failed "build failed: <error>".
2. `preview` env `ensure(app, 'preview', 'p'+depId.slice(-6))`; `copyUserSecrets` (non-managed vars from staging, re-sealed for preview); `deployAndTest`. Fail → "preview tests failed". Target preview → done "preview ready at https://<host>" (passed).
3. (ship) `staging` env ensure + `deployAndTest`; fail → "staging tests failed".
4. `production` env ensure; `runtime.release(..., 'ship')`; log "live at … (watching for errors; automatic rollback is armed)"; smoke test; fail → rollback reason `automatic: production smoke test failed`, pipeline failed. Else done "shipped to https://<host>".

`deployAndTest(env)`: release (reason = stage) → log "deployed…; running smoke tests" → smoke (must pass) → e2e (must pass; skipped counts as passed) → "e2e passed".

`Pipeline.build` (slot-limited to MAX_CONCURRENT_BUILDS via in-process queue; deadline = BUILD_TIMEOUT_MINUTES):
- Work dir `<DATA_DIR>/builds/<depId>/work`.
- Step `extract` (`extractSource`): output `<n> files`.
- Step `security-scan` (`scanSource`): blocking → failed "Security scan found N blocking issue(s)."; warnings → `warning`.
- Step `detect` (`detectManifest`): missing package.json → "No package.json in the project root."; no backend and no frontend → "Nothing to deploy." Manifest saved to `deployments.manifest`.
- `chownTree(work, 10001)` when running as root.
- Optional `lockfile` warning step if no `package-lock.json`.
- Sandbox steps (each in fresh container `basalt-build-<depId>-<step>`):

| Step | Command (when run) | Skipped when |
|---|---|---|
| install | `npm ci --ignore-scripts --no-audit --no-fund` (lockfile) or `npm install --ignore-scripts --no-audit --no-fund` | never |
| audit | `npm audit --omit=dev --audit-level=critical` (soft: failure tolerated only if output matches `/ENOAUDIT|audit endpoint|ECONNREFUSED|EAI_AGAIN|status 5\d\d|not supported/i` → `warning`) | never |
| typecheck | `npm run typecheck` | no `typecheck` script |
| lint | `npm run lint` | no `lint` script |
| unit-tests | `npm test` | no `test` script or default "no test specified" |
| build | `npm run build` | `manifest.frontend.build` false |
| package | `node .basalt-package.cjs && cd .basalt-out/app && (npm ci|npm install) --omit=dev --ignore-scripts --no-audit --no-fund` | no backend |

- `.basalt-package.cjs` copies every top-level entry except `node_modules`, `.basalt-out`, `.basalt-package.cjs`, `e2e`, `test-results`, `playwright-report`, frontend output dir into `.basalt-out/app` (`verbatimSymlinks`).
- Failure messages: audit → "Production dependencies have critical vulnerabilities."; else `Step "<name>" failed.`
- Build container spec: Image BUILD_IMAGE, `User 10001:10001`, WorkingDir `/work`, `Cmd ['sh','-c',script]`, Env `npm_config_registry=<REGISTRY_URL>`, `npm_config_replace_registry_host=always`, `npm_config_cache=/tmp/npm-cache`, `npm_config_update_notifier=false`, `HOME=/tmp`, `CI=true`; labels `basalt.kind=build`, `basalt.deployment=<depId>`; `hardened({memoryMb: BUILD_MEMORY_MB, cpus: 2, pids: 1024, network: BUILD_NETWORK, tmpfsMb: 512, mounts: volume DATA_VOLUME Subpath builds/<depId>/work → /work})`.
- Step timeout = remaining deadline (min 1 s) → code -1, "(step timed out)"; logs tail 300; output kept ≤16 000 chars (≤4000 stored on pass); container removed.
- Step `static` (frontend): requires `<output>/index.html` ("Frontend build produced no index.html."); `copyStatic` → `<DATA_DIR>/artifacts/<depId>/static` (regular files only, symlinks skipped); precompress `.html .js .mjs .css .json .svg .txt .xml .webmanifest .map .wasm` > 1024 bytes to `.gz` (level 9) and `.br` (quality 11). Sets `deployments.static_dir`.
- Step `image` (backend): `buildContext` writes Dockerfile `FROM <RUNTIME_IMAGE>\nCOPY --chown=10001:10001 app /app\nWORKDIR /app\nUSER 10001:10001\n` — COPY only, no RUN; tar of `Dockerfile` + `app` (portable, no follow); Docker `POST /build?t=<tag>&rm=1&forcerm=1&pull=0&networkmode=none` (15 min timeout); `.basalt-out` removed. Sets `deployments.image`.
- Status `built`; any thrown error → step `internal` failed, "Build error: …". Error text ≤4000 chars.

`detectManifest`:
- `basalt.json` `{backend:{entry}|false, frontend:{output}|false}` overrides conventions.
- Backend entry candidates: configured entry, else `server/index.ts`, `server/index.js`, `server/index.mjs`; must match `/^[\w./-]+$/`, no `..`, exist.
- Frontend: configured output (build = has `build` script); else `build` script → `dist`; else `public/index.html` → `public` (no build). Output must be relative, no `..`.
- `e2e`: `e2e/` contains `*.spec|test.[cm]?[jt]s`. `migrations`: `db/migrations/*.sql`. `lockfile`: `package-lock.json`. `scripts`: package.json script names.

Upload handling (`sources.ts`):
- `MAX_UPLOAD_BYTES` 50 MiB; must start with gzip magic `1f 8b`; stored `<DATA_DIR>/sources/<sha256>.tgz` mode 0600 (tmp + rename, dedup).
- Extraction: `strict`, no preservePaths/owner, `noChmod`; only File/Directory/OldFile/ContiguousFile; SymbolicLink/Link → violation "links are not allowed in uploads"; absolute or `..` → "unsafe path in upload"; silently drops `/(^|\/)(node_modules|\.git|\.basalt|\.e2e-app)(\/|$)|(^|\/)\.env(\.[^/]*)?$|(^|\/)\.npmrc$/`; max 20 000 files, 300 MiB unpacked; violation → dest removed, throw.

Scanner (`scanner.ts`):
- Skips dirs: node_modules, .git, dist, build, out, .basalt-out, coverage, test-results, playwright-report; skips files > 1 MiB.
- Secret patterns (always blocking, severity critical, rule `hardcoded-<name>`): private-key PEM, aws-access-key `(AKIA|ASIA)[0-9A-Z]{16}`, stripe-live-key `(sk|rk)_live_…{20,}`, github-token `gh[pousr]_…{36,}`, slack-token `xox[baprs]-…`, google-api-key `AIza…{35}`, openai-key `sk-(proj-)?…{32,}`, anthropic-key `sk-ant-…{32,}`. First matching line per file per rule.
- Code files `.ts .tsx .js .jsx .mjs .cjs .sql .vue .svelte`, excluding paths under `e2e/`, `test/`, `tests/`, `__tests__/` and `*.test|spec.[jt]sx?`: `reviewApiCode` (api-mcp) — critical/high blocking, others warnings.

##### 6.7 Releases, hardening, promotion, rollback

`hardened()` HostConfig (all user-code containers):

| Field | Value |
|---|---|
| NetworkMode | given network |
| Memory / MemorySwap | memoryMb MiB (equal → no swap) |
| NanoCpus | cpus × 1e9 |
| PidsLimit | default 256 |
| ReadonlyRootfs | true (default) |
| Tmpfs | `/tmp: rw,nosuid,nodev,size=<tmpfsMb default 64>m` |
| CapDrop | ALL |
| SecurityOpt | `no-new-privileges:true` |
| Init | true |
| Ulimits | nofile 4096/4096 |
| LogConfig | json-file max-size 10m, max-file 3 |
| RestartPolicy | `on-failure` max 5 if restart else `no` |
| Mounts / ExtraHosts | optional |

Container resource table:

| Container | Name | Image | Memory | CPUs | Pids | Network | tmpfs | Timeout |
|---|---|---|---|---|---|---|---|---|
| build step | `basalt-build-<dep>-<step>` | BUILD_IMAGE | BUILD_MEMORY_MB (1536) | 2 | 1024 | BUILD_NETWORK | 512m | build deadline (15 min total) |
| migration | `basalt-migrate-<env>-<dep last8>` | app image | 256 | 0.5 | 256 | env network | 64m | 120 s |
| app backend | `basalt-app-<env>-<rel last8>` | app image | 256 (prod 512) | 0.5 (prod 1) | 256 | env network | 64m | health 90 s |
| e2e runner | `basalt-e2e-<runId>` | TEST_IMAGE | TEST_MEMORY_MB (1536) | 2 | 2048 | `basalt-test-<runId>` | 512m, ShmSize 256 MiB | 10 min |

- All run as `User: 10001:10001`.
- App container: WorkingDir `/app`; `Cmd ['node', '--max-old-space-size=<floor(mem*0.75)>', <backend entry>]`; Env = all env vars + `HOME=/tmp`; labels `basalt.env`, `basalt.release`, `basalt.app`, `basalt.kind=app`; Healthcheck `wget -qO- http://127.0.0.1:3000/_basalt/health` interval 2 s, timeout 2 s, retries 3, start period 2 s; restart on-failure.
- Migration container: `node /opt/basalt/migrate.mjs /app/db/migrations`, Env `DATABASE_ADMIN_URL`, `HOME=/tmp`; label `basalt.kind=migration`; ok if exit 0 or 2; skipped if no migrations or no image.

`Runtime.release(app, env, dep, reason)` (serialized per env via promise chain `serial(envId)`):
1. `assertActive` (env not deleting). Insert release (`starting`).
2. Migrations; fail → release failed "migrations failed: …".
3. If backend: start container, `waitHealthy` (poll 1 s up to 90 s; exited/dead → fail with exit code); unhealthy → logs tail 80, remove, fail "backend did not become healthy (…)".
4. Transaction: release `live` + container + live_at; env `current_release_id`, `sleeping=false`, `last_active_at=now()`; previous → `superseded`.
5. `routes.sync()` (version++ and `POST <EDGE_ADMIN_URL>/reload`, 3 s timeout).
6. Drain: previous container stopped (`t=10`) after 15 s.
7. `pruneOld`: keep 3 most recent non-live releases with containers; remove rest (container set NULL).
8. Production: `watch()` armed.

Auto-rollback `watch` (production only): first tick after 10 s, then every 10 s, for 180 s; stops if env not ready or release no longer current. Triggers:
- Container missing, health `unhealthy`, or state ≠ running → "backend became unhealthy after release".
- Edge `last2m.requests >= 20` and `errors5xx/requests > 0.3` → "error rate N% after release".
- Rollback reason `automatic: <reason>`.

`Runtime.rollback(app, env, toReleaseId?, reason='manual rollback')`: target = given release in env, else most recent `superseded`/`rolled_back` (≠ current) by `live_at DESC NULLS LAST`; none → "There is no previous release to roll back to." Restart existing container or start new one; must be healthy. Target → live (ended_at NULL), env current, `sleeping=false`; current → `rolled_back` with reason; `routes.sync`; old container stopped after 10 s; log warn `rolled_back`.

Promotion (`Host.promote`):
- Deployment must be `built`.
- `to: 'production'`: requires latest staging test runs for this deployment: smoke `passed` and (if manifest.e2e) e2e `passed`; else 409 "Production promotion requires this deployment to pass its tests in staging first…".
- `to: 'staging'`: ensure staging env, new pipeline (target `staging`), async `deployAndTest`, returns `{pipelineId, url}`.
- `to: 'production'`: release reason `promote`, smoke test; failure → rollback (`automatic: production smoke test failed`) and UserError 500 "Released, but the production smoke test failed, so it was rolled back: …". Returns `{releaseId, url}`.
- `restartLive` (secret/config change) = new release of same deployment, reason `config change`.

`Host.waitFor`: polls `deploymentStatus` every 2 s until no running pipelines and status not queued/building, or timeout. `deploymentStatus` returns deploymentId, status, error, steps (output trimmed to last 500 chars unless failed), manifest, pipelines, tests (kind/status/summary/env), liveIn.

`recover()` on startup: deployments queued/building → failed "interrupted by platform restart; deploy again"; running pipelines → failed + log entry; running test_runs → error; starting releases → failed "interrupted".

##### 6.8 Sleep / wake / janitor

- Janitor every 60 s (`main.ts`): (a) retry destroy for envs in `deleting`; (b) fetch edge metrics; for each ready env update `last_active_at` from edge `lastRequestAt`; (c) previews past `expires_at` → deleting + destroy; (d) non-production, not sleeping, with a release, idle > SLEEP_AFTER_MINUTES → stop container (t=10), `sleeping=true`, `routes.sync`. Production never sleeps.
- Wake (`/internal/wake` → `Runtime.wake`): only if sleeping and ready; serialized; start container, wait healthy (90 s), `sleeping=false`, `last_active_at=now()`, `routes.sync`.
- Edge side: see §7.9.

##### 6.9 Environment destroy (`Environments.destroy`)

Order: status `deleting` → remove all containers labeled `basalt.env=<id>` → `DELETE <AUTH_INTERNAL_URL>/v1/platform/projects/<id>` (Bearer AUTH_PLATFORM_KEY, `x-basalt-owner`, 15 s; errors swallowed) → `deleteDataProject` (not swallowed) → Redis `ACL DELUSER u_<envId>`, `ACL SAVE` → `DROP DATABASE IF EXISTS <db> WITH (FORCE)`, `DROP ROLE IF EXISTS <db>_app`, `<db>_admin` → disconnect infra containers → remove network → rm `<DATA_DIR>/test-runs/<envId>` → delete row → `routes.bump`. `Host.destroyEnv` serializes behind in-flight releases.
`deleteApp`: destroys all envs, removes all deployment images (`DELETE /images/<tag>?force=true`), deletes app row (cascade), audit.

##### 6.10 Secrets and encryption

- `SecretBox`: AES-256-GCM, key = MASTER_KEY (32 bytes), 12-byte random IV, AAD bound to owner. Blob = `0x01 | IV(12) | tag(16) | ciphertext`; `open` rejects version ≠ 1.
- AAD strings: env vars `env:<envId>:<NAME>`; access keys `access:<envId>`; Cloud data admin key `data:<envId>`.
- User secrets (`setSecret`): name `/^[A-Z][A-Z0-9_]{1,63}$/`, not `/^(BASALT_|DATABASE_|REDIS_|NODE_|HTTPS?_PROXY$|NO_PROXY$|PORT$|HOME$|PATH$)/`; value ≤16 384 chars; env `all` = every ready env, `production` = slug prod, else slug; stored `secret:true, managed:false`; live release restarted. Audit stores name only.
- `deleteSecret` only deletes `managed=false`. `listSecrets` returns `{yours:[{name,updatedAt}], platformManaged:[names]}` (never values).
- New previews copy staging's non-managed vars.

##### 6.11 Workspace tokens and admin CLI

- `createWorkspace(name)`: id `ws_…`; token `bht_` + 32 random bytes base64url (43 chars); stores SHA-256 in `api_tokens` (name `agent`).
- `authenticate`: format `/^bht_[A-Za-z0-9_-]{43}$/`, hash lookup with `revoked_at IS NULL`, updates `last_used_at` (fire-and-forget).
- `admin.ts` (`docker exec basalt-control node dist/admin.js …`): `create-workspace <name>` prints workspace id + `.mcp.json` snippet `{mcpServers:{basalt:{command:'npx', args:['-y','--registry','https://registry.<root>/','@basalt/host-mcp'], env:{BASALT_HOST_URL:'https://host.<root>', BASALT_HOST_TOKEN}}}}`; `under-attack on|off` → upsert `platform_settings.under_attack`, `routes.bump()` (no sync).

##### 6.12 Registry publishing (`registry.ts`, `scripts/pack-basalt.mjs`)

- At image build, `pack-basalt.mjs <repoRoot> <outDir>` packs `auth/packages/sdk`, `api/packages/framework`, `hosting/packages/mcp`: rewrites `file:` deps (dependencies/peer/optional) → `^0.1.0`, deletes `private`, `devDependencies`, `scripts`; for hosting mcp sets name `@basalt/host-mcp`, `bin {basalt-host-mcp: dist/main.js}`, `files ['dist']`; copies `dist`; `npm pack --pack-destination <out>`.
- At control startup (`publishBasaltPackages`, background): reads `*.tgz` in `/opt/basalt/packages`; requires `REGISTRY_PUBLISH_PASSWORD`; registers user `basalt-platform` via `PUT /-/user/org.couchdb.user:basalt-platform` (up to 30 tries × 2 s; ok or 409); writes temp `.npmrc` (mode 0600) with `_auth` Basic and `always-auth`; `npm publish <tgz> --userconfig … --registry … --access public` (60 s timeout) per file sorted; conflicts (`EPUBLISHCONFLICT|cannot publish over|409|already present|E403`) skipped; temp dir removed.
- Public route `registry.<root>` → verdaccio, GET/HEAD only, 1200/min/IP.

##### 6.13 Data link to Basalt Cloud (`data-link.ts`)

- Config `{url: CLOUD_INTERNAL_URL, platformKey: CLOUD_PLATFORM_KEY}`; calls Bearer key, JSON, 30 s timeout; non-ok or `!json.ok` → `CloudError("Basalt Cloud: <message>")`.
- Project id regex `/^[a-z0-9]{10}$/`.
- `createDataProject`: `POST /api/platform/projects {name, authProjectId, authOwner, externalId}` → `{project.id, adminKey}` (validated).
- `deleteDataProject(envId, recordedProjectId)`: `DELETE /api/platform/environments/<envId>` (if envId matches `/^[A-Za-z0-9_-]{1,64}$/`); 404 = gone; if not found and recorded id valid → `DELETE /api/platform/projects/<id>` (404 ok); other errors throw.
- `setDataRules`: non-production → `PUT /api/platform/projects/<id>/rules {contract}` (platform key) → `{status:'live', summary}`; production → `PUT /api/projects/me/rules {contract}` with env admin key → `waiting_for_owner {approveUrl, why[], summary}` or `live`.
- `dataUrlFor` → `<url>/p/<projectId>` or null.
- `Host.dataRules`: 409 if no data link/project/admin key; Cloud error → UserError 400 (prefix stripped); audit `data_rules.updated`.
- Route `cloud.<root>` → Cloud, methods GET/POST/PUT/OPTIONS, 600/min/IP (only if data link).

##### 6.14 Testing (`testing.ts`)

- `accessToken(env, ttl=3600)`: `signToken(accessKey, {env: envId, exp})`; null for production.
- `shareLink(env, ttlMinutes)` → `https://<host>/_basalt/access?t=<token>` (production: plain `https://<host>/`). MCP `host_share_link` ttl 5..10080 min, default 1440.
- `edgeGet`: HTTPS to `edge:443`, SNI = env host, `rejectUnauthorized:false`, headers host, `accept: text/html,application/json`, `x-basalt-access` (300 s token); 15 s timeout; body ≤20 000.
- Smoke (waits 1.5 s first). Checks:
  - frontend: "GET / returns the app (200, HTML)"; "security headers present (CSP)" (`default-src 'self'`).
  - backend: "backend is running and answers signed requests" (`callBackend('/_basalt/introspect')`); "API reachable through the edge" (`GET /api/__basalt_smoke__` status in 401/404/405).
  - exception → "edge reachable" failed.
- Test users (preview/staging only; env must have auth project): email `test-<10 hex>@test.basalt.invalid`, password `T3st-<12 random bytes b64url>`; `POST <AUTH_INTERNAL_URL>/v1/platform/projects/<id>/users` (Bearer AUTH_PLATFORM_KEY, `x-basalt-owner`).
- e2e: skipped-as-passed if no e2e; requires `node_modules/@playwright/test` version starting `1.64` (`PLAYWRIGHT_VERSION`), else `error`. Writes `<DATA_DIR>/test-runs/<envId>/<runId>/basalt.config.ts` (imports app's `playwright.config.ts` if present; `testDir /work/e2e`, `outputDir /out/test-results`, reporters json `/out/results.json` + list, `workers 2`, `retries 0`, `timeout 30_000`, `webServer undefined`, `baseURL=$BASE_URL`, `ignoreHTTPSErrors`, `extraHTTPHeaders x-basalt-access=$BASALT_ACCESS`, trace off, screenshot only-on-failure); symlinks `node_modules` → `/work/node_modules`.
  - Isolated internal network `basalt-test-<runId>` (label `basalt.test`); edge connected with alias `edge`; ExtraHosts `<env host>:<edge IP>`.
  - Container Env: `BASE_URL=https://<host>`, `BASALT_ACCESS` (1800 s token), `TEST_USER_EMAIL`, `TEST_USER_PASSWORD`, `HOME=/tmp`, `CI=1`; Cmd `npx playwright test -c /out/basalt.config.ts`; mounts `/work` (read-only Subpath of build work dir), `/out` (Subpath test-runs/…).
  - Summary from JSON stats: passed=expected, failed=unexpected+flaky, skipped, durationMs, failures (≤20, ANSI stripped, ≤1500 chars); no results → `error` ("Test run timed out (10 min)." or "Playwright produced no results.").
  - Cleanup: remove container, disconnect edge, remove network, remove symlink.
- Emails: auth mail webhook verified with `basalt-signature: t=<unix>,v1=<hex64>`, |now−t| ≤ 300 s, HMAC-SHA256(MAIL_WEBHOOK_SECRET, `<t>.<rawBody>`), timing-safe; body `{projectId,to,subject,text}`; env by `auth_project_id`; stored in `emails`, trimmed to newest 200 per env; production additionally sent via `POST https://api.resend.com/emails` (from MAIL_FROM) if `RESEND_API_KEY`, else warn `production_mail_not_delivered`. `host_test_emails` returns 20 newest; production refused.

##### 6.15 Metrics, logs, protection, CSP

- `Host.metrics`: `{url, edge: edgeMetrics.hosts[host] ?? {requests:0}, backend: {state, health, restarts, startedAt}|null, sleeping}`.
- `Host.logs`: docker logs of live container, tail ≤2000 (default 200), `since` minutes, case-insensitive grep, last 60 000 chars.
- `ProtectionPatch` (strict partial): perIpPerMinute 10..10 000, maxConcurrency 1..512, underAttack bool, maxBodyBytes 1024..50 MiB. Merged over DEFAULT_PROTECTION; `routes.sync`; audit.
- `CspPatch` (strict partial): connectSrc/scriptSrc/imgSrc/styleSrc/fontSrc/frameSrc arrays ≤20 of `/^https:\/\/(\*\.)?[a-z0-9.-]+\.[a-z]{2,}(:\d{1,5})?$/`; replaces each list given; `routes.sync`.
- API config / route policy: `readConfig`/`writeConfig`/`mergeConfig`/`setRoutePolicy` from `@basalt/api-mcp` on the env's HostedPlatform (deep merge; `replace` option); audit `api_config.updated`.

##### 6.16 Route table (`Host.routeTable`)

- App routes for envs `status='ready'` joined with current release + deployment; skipped if no `BASALT_EDGE_SECRET` var or no `auth_project_id`.
- `backend = http://<container>:3000` or null; `staticDir` = deployment static_dir; `accessKey` decrypted; protection/csp merged with defaults; `dataUrl`.
- Service routes:

| Host | Upstream | Methods | perIpPerMinute |
|---|---|---|---|
| `registry.<root>` | REGISTRY_URL | GET, HEAD | 1200 |
| `cloud.<root>` (if data link) | CLOUD_INTERNAL_URL | GET, POST, PUT, OPTIONS | 600 |
| `host.<root>` | `http://control:<PORT>` | GET, POST, PUT, PATCH, DELETE | 600 |

- `underAttack` from `platform_settings.under_attack`. `version` = in-memory counter initialised to `Date.now()` at startup.

#### 7. Edge (`hosting/packages/edge`)

##### 7.1 Process (`main.ts`)

- Required env: `CONTROL_URL`, `INTERNAL_TOKEN`, `EDGE_KEY`, `AUTH_INTERNAL_URL`. Optional: `TRUSTED_PROXIES` (comma list, exact IPs), `PORT` (8080), `INTERNAL_TLS_PORT` (8443; compose 443), `TLS_DIR` (`/data/edge-tls`; compose `/tls`), `ADMIN_PORT` (9090).
- Route table client polls `<CONTROL_URL>/internal/routes` every 1000 ms (3 s timeout, `If-None-Match: <version>`); keeps last good table on failure (warn `route_table_unreachable`).
- Listeners: public HTTP (maxHeaderSize 16 KiB), internal HTTPS (self-signed RSA-2048 cert `CN=basalt-internal-edge`, 3650 days, generated with openssl if `cert.pem` missing), admin HTTP. Hardening on public/internal: `headersTimeout 10 s`, `requestTimeout 120 s`, `keepAliveTimeout 65 s`, `maxHeadersCount 100`, `maxConnections 20 000`.
- Wake callback: `POST <CONTROL_URL>/internal/wake {envId}`, Bearer, 5 s timeout.
- SIGTERM/SIGINT: stop polling, close listeners, exit after 10 s.

##### 7.2 Request pipeline (`handle`), in order

| # | Check | Result | Shield penalty | blocked reason |
|---|---|---|---|---|
| 1 | `x-request-id` set (random UUID) on every response | | | |
| 2 | Client banned | 403 `blocked`, `retry-after` = ban seconds | – | `banned` |
| 3 | Per-IP in-flight > 64 | 429 `rate_limited`, retry-after 1 | 1 | `ip_concurrency` |
| 4 | Global in-flight > 4000 | 503 `overloaded`, retry-after 2 | – | `overloaded` |
| 5 | Method not in GET HEAD POST PUT PATCH DELETE OPTIONS | 405 | 2 | `bad_method` |
| 6 | `normalizePath` fails or no Host | 400 `bad_request` | 3 | `bad_request` |
| 7 | Global per-IP bucket 2400/min (burst 400) | 429 + retry-after | 1 | `rate_limited` |
| 8 | Host not in table | 404 `unknown_site` | – | `unknown_host` |
| 9 | `shield.inspect` (WAF-lite) | 404/400/403 | 5/3/10 | `scanner_path`/`bad_encoding`/`attack_signature` |
| 10 | Per host+IP bucket (route perIpPerMinute; burst max(10, ceil(n/6))) | 429 + retry-after | 1 | `rate_limited` |
| 11 | Dispatch to service or app handler | | | |

- Client IP: `CF-Connecting-IP` only if socket remote address ∈ TRUSTED_PROXIES and value is an IP; else socket address (strip `::ffff:`). Rate/ban key = `ipBucket(ip)` (IPv6 /64).
- Host: lowercased, port stripped.
- Uncaught errors → 502 `bad_gateway` "The app could not be reached." (or socket destroy if headers sent).
- Error JSON shape: `{"error":{"code","message","requestId"}}`; `send()` adds `cache-control: no-store`, `x-content-type-options: nosniff`; HTML if body starts `<!doctype`.

##### 7.3 Bans and WAF-lite (`shield.ts`)

- Score per client key, decays 2 points/min; threshold 30 → ban; duration `min(24 h, 10 min × 2^(bans−1))`; score reset; max 200 000 clients (LRU). Log `client_banned` when a WAF verdict triggers a ban.
- Scanner paths (404, score 5): `/.env /.git /.svn /.hg /.ds_store /.aws /.ssh /.htaccess /.htpasswd /wp-admin /wp-login.php /wp-content /wp-includes /xmlrpc.php /phpmyadmin /pma /myadmin /admin.php /cgi-bin /server-status /actuator /vendor/phpunit /boaform /hnap1 /solr /console /owa /autodiscover /telescope /_profiler /debug/default` (case-insensitive, followed by `/`, end, or `?`).
- Query decode failure (`decodeURIComponent` after `+`→space) → 400 `bad_encoding`, score 3.
- Attack signatures on path or decoded query (403, score 10): `../` or `..\`; `<script`; `union [all] select` (incl. `/* */`); `/etc/passwd|shadow`; `${jndi:`; `; (rm|wget|curl|nc|bash|sh) `; `sleep(<n>)`; `waitfor delay`.
- `normalizePath` rejects: not starting `/`, length > 8192, undecodable, control chars/DEL/backslash after decode, `.` or `..` segments, residual `%2e %2f %5c %00` (double encoding).
- Admin: `GET /bans` → `[{ip, until, bans}]`; `DELETE /bans?ip=` unbans (removes entry).

##### 7.4 App handler routing (`handleApp`), in order

1. `/_basalt/edge-health` → 200 `{ok:true}` (before private gate).
2. `GET /_basalt/access?t=<token>` → verify with route `accessKey`, `payload.env === envId`; ok → 303 to `/` with `Set-Cookie: basalt_access=<t>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=<exp−now, ≥1>`; else 403 HTML "Link expired".
3. `POST /_basalt/challenge` → reads ≤2048 chars JSON `{challenge, nonce}`; valid → 204 with `basalt_clearance` cookie (HttpOnly; Secure; SameSite=Lax; Max-Age=3600); invalid → 403 `challenge_failed`, penalty 2.
4. Private gate (route has `accessKey`, i.e. preview/staging): token from cookie `basalt_access` or header `x-basalt-access`; must verify and `env === envId`; else 401 — HTML "Private environment … Ask for a share link." if `Accept` has text/html, else JSON `environment_private`.
5. Under-attack (route `protection.underAttack` OR table `underAttack`): without valid clearance cookie → GET+HTML gets 200 challenge page; others 403 `challenge_required` "Please load the site in a browser first."
6. `/_basalt/auth[/…]` → `<AUTH_INTERNAL_URL>/v1/projects/<projectId><rest>?<query>`; adds `x-forwarded-prefix: /_basalt/auth`; max body 64 KiB; security headers (non-HTML) added to response.
7. `/_basalt/data[/…]` → only if `dataUrl` set and (POST `/v1/data/(get|list|create|update|archive|restore)`, POST `/v1/files`, POST `/v1/files/link`, or GET `/v1/files/download/<64 hex>`); else 404. Target `<dataUrl><rest>` (query not forwarded). Body limit 256 KiB (`/v1/files`: 6 MiB). Upstream `set-cookie` dropped. Security headers added.
8. Any other `/_basalt/*` → 404 (backend internals such as introspect/OpenAPI/readiness never public).
9. `/api` and `/api/*` → backend (see 7.6); 404 if no backend.
10. Else static (404 JSON if no staticDir).

##### 7.5 Proof-of-work challenge (`challenge.ts`)

- Cookie `basalt_clearance`. Difficulty 4 leading hex zeros of SHA-256(challenge + nonce) (~65k hashes).
- Challenge token signed with EDGE_KEY: `{ip: ipKey, host, n: 8 random bytes hex, d: 4, exp: now+300}`.
- Nonce ≤32 chars; client iterates `i.toString(36)` with `crypto.subtle.digest`, POSTs `/_basalt/challenge`, reloads on ok.
- Clearance token `{ip, host, exp: now+3600}`; bound to IP bucket + host.
- Challenge page: `<meta name="robots" content="noindex">`, inline script with per-response nonce (12 random bytes base64); CSP override `default-src 'none'; script-src 'nonce-<n>'; connect-src 'self'; style-src 'unsafe-inline'`.

##### 7.6 Backend proxy and HMAC signing

- Wake-if-sleeping first (`wakeAndWait`); still sleeping/no backend → 503 `waking_up`, retry-after 3.
- Bulkhead: per-env concurrency `protection.maxConcurrency` (default 64) → 503 `busy`, retry-after 1.
- Signature header `basalt-edge-signature: t=<unix s>,v1=<hex HMAC-SHA256(edgeSecret, "<t>\n<METHOD>\n<pathAndQuery>\n<requestId>")>`; `pathAndQuery` = canonical `URL(raw).pathname + search` (same string used for forwarding).
- Target `<backend><canonicalUrl>`; body limit `protection.maxBodyBytes` (default 10 MiB).
- Retry: GET/HEAD connection errors (`ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT`) → wake once, re-sign, retry.
- undici Agent: keepAlive 30 s, 256 connections, headersTimeout 30 s, bodyTimeout 60 s.
- Body limit: declared `content-length` > max → 413 + `connection: close` without reading; streamed bodies counted, abort on overflow → 413.
- Service routes: method allowlist (405 with `allow`), target `<upstream><encodeURI(path)>?<query>`, body limit 50 MiB, adds `strict-transport-security: max-age=63072000`.

##### 7.7 Headers stripped / added

- Request headers never forwarded from clients: `basalt-edge-signature, x-request-id, x-forwarded-for, x-forwarded-host, x-forwarded-proto, x-forwarded-prefix, x-real-ip, forwarded, cf-connecting-ip, true-client-ip, x-basalt-access, connection, keep-alive, proxy-connection, transfer-encoding, upgrade, te, trailer, host`.
- Cookies: `basalt_access` and `basalt_clearance` removed from forwarded `cookie`; other cookies kept.
- Added upstream: `x-forwarded-for: <client ip>`, `x-forwarded-host: <host>` (plus `:<PUBLIC_PORT>` on the plain listener when set), `x-forwarded-proto: https` (internal TLS listener) or `PUBLIC_SCHEME` (plain listener; default https), and for service routes (registry, cloud, host) `host: <public host>` so Verdaccio's tarball URLs use the public name (readiness pass), `x-request-id: <uuid>`; plus `basalt-edge-signature` (backend) / `x-forwarded-prefix` (auth).
- Response headers stripped: `connection, keep-alive, transfer-encoding, server, x-powered-by` (+ `set-cookie` for data).
- Security headers (`securityHeaders`) on app responses: `x-content-type-options: nosniff`, `referrer-policy: strict-origin-when-cross-origin`, `permissions-policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`, `cross-origin-opener-policy: same-origin`, `x-frame-options: DENY`; production `strict-transport-security: max-age=63072000; includeSubDomains`; non-production `x-robots-tag: noindex, nofollow`.
- CSP (HTML only): `default-src 'self'; script-src 'self' <scriptSrc> ['nonce-…']; style-src 'self' 'unsafe-inline' <styleSrc>; img-src 'self' data: blob: <imgSrc>; font-src 'self' data: <fontSrc>; connect-src 'self' <connectSrc>; frame-src <frameSrc or 'none'>; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`.

##### 7.8 Static serving (`static.ts`)

- Only GET/HEAD (else 405 with `allow: GET, HEAD`); any path segment starting `.` → 404; production `*.map` → 404.
- Resolution confined to root (`path.resolve` prefix check); directories → `index.html`; trailing `/` → `index.html`.
- SPA fallback: path without extension and `Accept` contains `text/html` (or no Accept) → `/index.html`.
- "HTML-ish" (CSP applied) = no `.` in path, or ends `.html` or `/`.
- ETag `W/"<size hex>-<mtime hex>"`; `If-None-Match` match → 304.
- Cache: production HTML `no-cache`; hashed assets (`/[.-][A-Za-z0-9_-]{8,}\.(js|mjs|css|woff2?|png|jpe?g|svg|webp|avif)$/`) `public, max-age=31536000, immutable`; others `public, max-age=300`. Non-production: HTML `no-store`, others `private, max-age=60`.
- Precompressed: `.br` preferred, then `.gz` if Accept-Encoding contains it and file exists; `vary: Accept-Encoding`; `content-length` set.
- MIME map: html, js, mjs, css, json, svg, png, jpg/jpeg, gif, webp, avif, ico, woff, woff2, ttf, txt, xml, webmanifest, wasm, mp4, webm, pdf; default `application/octet-stream`.
- Not-found → 404 HTML "Not found." with security headers.

##### 7.9 Wake-on-request

- `wakeAndWait(route)`: call wake (errors logged `wake_failed`), then wait for table changes (`changed(1500)`) up to 25 s until route is awake with backend.
- Triggered by `/api` requests to sleeping envs and by GET/HEAD connection failures. Static frontend served without waking.

##### 7.10 Metrics (`metrics.ts`)

- Per host: requests, 2xx/3xx/4xx/5xx counts, blocked by reason, latency sum, buckets `[10,25,50,100,250,500,1000,2500,5000,∞]` ms, lastRequestAt, recent `[time,status]` (≤2000 entries / 10 min).
- Snapshot: `{inflight, hosts: {<host>: {requests, status{2xx..5xx}, blocked, latencyMs{avg,p50,p95,p99 ('>5000' for ∞)}, lastRequestAt, last2m{requests, errors5xx}}}}`. Unknown/empty host recorded as `(none)`.
- Consumers: control `host_metrics`, auto-rollback (last2m), janitor (lastRequestAt).

#### 8. Egress proxy (`hosting/packages/egress`)

- Listens `0.0.0.0:<PORT default 3128>`; `headersTimeout 10 s`, `requestTimeout 30 s`.
- Defaults: ports `{80, 443}`, `maxConnsPerClient 128`, `newConnsPerMinute 1200` (burst ceil(1200/4)=300), `idleTimeoutMs 60 s`, `maxLifetimeMs 15 min` (CONNECT tunnels), TokenBuckets capacity 50 000 keys.
- Client key = socket remote address.
- Plain HTTP: request URL must be absolute `http:` (else 400 "absolute http:// URL required"); strips `proxy-connection`, `proxy-authorization`; connects to vetted IP with `host` header = URL host.
- CONNECT: target must match `/^([^:]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/` else 400; replies `200 Connection Established`; idle + lifetime caps.
- Vetting order (`vet`):
  1. Port not allowed → 403 "port N is not allowed (web ports only)".
  2. Host empty, >253 chars or not `/^[A-Za-z0-9.\-:[\]]+$/` → 400 "bad host".
  3. Rate limit → 429 "too many outbound connections".
  4. Resolve (IP literal used as-is; else `dns.lookup all, verbatim`); none → 502 "cannot resolve".
  5. ANY resolved address non-public (`isNonPublicAddress`) → 403 "<host> is not a public internet destination".
  6. Connect to first vetted address (no re-resolution; anti DNS-rebinding).
- Concurrent connection cap per client → 429.
- Denials logged `egress_denied {client, target, reason}`; `stats {allowed, denied}`.
- Allowed: public unicast IPv4/IPv6 destinations on ports 80/443 only. Blocked: everything else (private, loopback, link-local/metadata 169.254.x, CGNAT, documentation, multicast, reserved, IPv4-mapped IPv6, NAT64, 6to4, ULA, other ports incl. SMTP).

#### 9. Browser worker (`hosting/packages/browser`)

- HTTP API on `0.0.0.0:<PORT default 7070>`; every request needs `Authorization: Bearer <INTERNAL_TOKEN>` (401) and `x-basalt-owner` (400 "owner required"; control sends workspace id). Body ≤64 KiB JSON.

| Method | Path | Action |
|---|---|---|
| POST | `/sessions` | `open({host, accessToken, owner, path})` |
| GET | `/sessions` | list owner's sessions `{sessionId, host, url, idleSeconds}` |
| POST | `/sessions/<uuid>/act` | `act(id, owner, action)` |
| DELETE | `/sessions/<uuid>` | `{closed: bool}` |

- Errors → 422 with first line of message (≤500 chars); unknown → 404.
- Chromium launch: headless; `--host-resolver-rules=MAP *.<root> <edgeHost>, MAP <root> <edgeHost>`; `--disable-dev-shm-usage`; raw flags `--proxy-server=<EGRESS_PROXY>` and `--proxy-bypass-list=<-loopback>;*.<root>;<root>` (readiness pass: Playwright's `proxy` option appended `<-loopback>` last, which Chromium evaluates first, so `*.localhost` platform hosts were proxied; loopback stays proxied and blocked). Relaunched if disconnected (all sessions cleared).
- Session model: max 6 sessions total (default); at capacity evicts the requesting owner's least-recently-used session, else error "Browser capacity reached…". Idle timeout 10 min (sweeper every 30 s). Sessions owner-scoped (others' ids → "Unknown or expired browser session").
- Context: `ignoreHTTPSErrors` (self-signed internal edge), viewport 1280×800, `serviceWorkers: 'block'`, `acceptDownloads: false`; access cookie `basalt_access` set for the host (HttpOnly, Secure, SameSite Lax).
- Host must be `<root>` or end with `.<root>` ("Only platform hosts can be opened."). Control only opens preview/staging with a 3600 s access token.
- Default action timeout 10 s; snapshot = `body` aria snapshot (5 s), truncated at 24 000 chars.
- Captured: console messages + `pageerror` (text ≤2000), failed requests and responses ≥400 (url ≤500); each ring buffer 300; reads return latest 100.
- Actions:

| type | Behaviour / returns |
|---|---|
| navigate `{path}` | path must start `/` and not `//`; `goto https://<session host><path>` (domcontentloaded, 20 s) + networkidle ≤5 s; url, title, status, snapshot |
| back / reload | domcontentloaded; url, title, snapshot |
| click `{target}` | click + settle (domcontentloaded 5 s, networkidle 3 s); snapshot |
| fill `{target, value}` | `{ok:true}` |
| press `{key, target?}` | element or keyboard press + settle; snapshot |
| select `{target, values}` | `{ok:true}` |
| check `{target, checked}` | `setChecked`; `{ok:true}` |
| hover `{target}` | `{ok:true}` |
| wait_for `{text?, target?, urlIncludes?, gone?, timeoutMs?}` | timeout min(given or 10 s, 30 s); visible/hidden; else wait ≤5 s; snapshot |
| snapshot | url, title, snapshot |
| screenshot `{fullPage?, target?}` | PNG base64 |
| evaluate `{expression}` | ≤5000 chars; `new Function('return (expr)')` in page; JSON value ≤10 000 chars |
| console | `{entries}` latest 100 |
| network | `{problems}` latest 100 |

- Target resolution priority: role(+name, exact) → label → placeholder → testId → text → selector; `nth` or `.first()`.

#### 10. MCP

##### 10.1 Remote MCP server (`hosting/packages/control/src/mcp.ts`)

- `McpServer {name:'basalt-host', version:'0.1.0'}`; instructions describe the workflow. Tool errors → `isError` with `Error: <msg>` (zod issues joined).
- Browser calls: `<BROWSER_URL><path>` with Bearer INTERNAL_TOKEN, `x-basalt-owner: <ws>`, 60 s timeout.
- `env` param: "staging", "production" or preview name; `testEnv`: staging or preview only.

| Tool | Annotation | One line |
|---|---|---|
| host_guide | readOnly | Returns guide topic (workflow, project, testing, operations, security). |
| host_status | readOnly | Lists workspace apps with envs (name, kind, url, status, sleeping, release, expiresAt). |
| host_create_app | | Creates/reserves app name (idempotent for own apps). |
| host_deploy_source | | `{app, sourceId(64 hex), message≤500, ship?}` starts pipeline (preview, or ship → production); waits ≤40 s. |
| host_wait | readOnly | Waits ≤45 s and returns deployment status (`done` flag). |
| host_deployment | readOnly | Full deployment status (steps, pipelines, tests, liveIn). |
| host_build_logs | readOnly | Full output of one CI step. |
| host_promote | | `{app, deploymentId, to: staging|production}` per §6.7. |
| host_rollback | destructive | Rolls env back to previous or given releaseId. |
| host_releases | readOnly | Last 10 releases of an env. |
| host_logs | readOnly | Backend logs `{tail 1..2000, sinceMinutes 1..1440, grep ≤100}`. |
| host_metrics | readOnly | Edge stats + backend container health. |
| host_secrets | readOnly | Secret names (user vs platform-managed). |
| host_set_secret | | Stores encrypted secret in env/"all"; restarts live release. |
| host_delete_secret | destructive | Removes a user secret. |
| host_data_rules | | Sets Data block rules; preview/staging live, production returns owner approval link. |
| host_data_status | readOnly | (readiness pass) Live / waiting / no rules, rules in plain English, owner's data map link. |
| host_data_admin | | (readiness pass) `{who (test person) | userId, label?}` → owner approval link to make someone an admin. |
| host_data_check | | (readiness pass) Guard on the env's data project (`scan?` ≤100 findings from the local tool); returns failures, scan findings and receipt link. |
| host_api_config | readOnly | Reads `BASALT_API_CONFIG`. |
| host_update_api_config | | Deep-merge (or replace) API config; zero-downtime restart. |
| host_route_policy | | Per-route override (`"POST /todos"`), null removes. |
| host_protection | | perIpPerMinute/maxConcurrency/underAttack/maxBodyBytes. |
| host_csp | | Extra https CSP sources per directive. |
| host_run_tests | | Re-runs smoke + e2e on a test env's live release (not production). |
| host_test_user | | Creates verified test account (email/password). |
| host_test_emails | readOnly | Captured emails of a test env (production refused). |
| host_share_link | | Time-limited access link (ttlMinutes 5..10080, default 1440). |
| browser_open | | Opens Chromium session on preview/staging (`path`), returns sessionId + snapshot. |
| browser_navigate | | Navigate to path. |
| browser_click | | Click target. |
| browser_fill | | Fill input. |
| browser_press | | Press key (optionally on target). |
| browser_select | | Select options. |
| browser_check | | Check/uncheck. |
| browser_hover | | Hover. |
| browser_wait_for | | Wait for text/target/url (timeoutMs ≤30 000). |
| browser_snapshot | readOnly | URL, title, accessibility snapshot. |
| browser_screenshot | readOnly | Returns image content (PNG) + URL. |
| browser_console | readOnly | Latest 100 console entries. |
| browser_network | readOnly | Latest 100 failed/4xx/5xx requests. |
| browser_evaluate | | Evaluates JS expression (≤5000 chars). |
| browser_close | | Closes session. |
| browser_sessions | readOnly | Lists own sessions. |
| host_delete_env | destructive | `{confirm: true}` deletes preview/staging env (production refused). |
| host_delete_app | destructive | `{confirm: true}` deletes app with all envs. |

- Plus `registerAuthTools(... include: auth_integration_guide, auth_security_rules, auth_review_code)` and `registerApiTools(... include: api_integration_guide, api_security_rules, api_review_code)`.
- Totals: 30 `host_*` + 16 `browser_*` + 6 auth/api = 52 remote tools; the local connector adds `host_deploy` and `host_init` (and overrides `host_data_check`) → 54 tools visible to the agent.

##### 10.2 Guides (`guides.ts`)

- Topics: `workflow`, `project`, **`data`** (readiness pass: rules format, browser `basalt()` client for `/_basalt/data` incl. uploads/file links, `ctx.data`, error codes, status/admin/Guard), `testing`, `operations`, `security`. Original description: `workflow` (10 steps, now 11 with host_data_check: create app → host_init → write code → review → host_deploy → debug → verify on preview → stage → ship → report), `project` (layout: package.json, package-lock.json, .npmrc, basalt.json, server/index.ts, server/routes, db/migrations/NNN_*.sql, src/ + index.html, public/index.html, e2e/*.spec.ts, playwright.config.ts; `@playwright/test ~1.64.0`; runtime Node 24, 256/512 MB, read-only FS except /tmp, proxy egress, PORT 3000), `testing`, `operations` (tool table; previews/staging sleep after 30 idle min; previews deleted after 24 h), `security` (what the platform enforces).

##### 10.3 Local stdio MCP (`hosting/packages/mcp`, published as `@basalt/host-mcp`, bin `basalt-host-mcp`)

- Env: `BASALT_HOST_URL`, `BASALT_HOST_TOKEN` (required, else exit 1), `BASALT_ROOT_DOMAIN` (default: URL hostname minus `host.`), `BASALT_REGISTRY_URL` (readiness pass), `BASALT_PROJECT_DIR` (default cwd). Package version 0.2.0.
- Connects MCP client to `<BASALT_HOST_URL>/mcp` (Streamable HTTP, Bearer token). Server `{name:'basalt', version:'0.1.0'}`.
- `tools/list` = local tools + remote tools (remote duplicates of local names dropped). Other calls proxied with 120 s timeout.
- Local tools:
  - `host_deploy {app (required), dir?, message?, ship?}`: `packProject` → `POST <url>/v1/apps/<app>/sources` (`content-type: application/gzip`) → remote `host_deploy_source {app, sourceId, message, ship}`; prepends "Uploaded N files (K KB)."
  - `host_data_check {app, env, dir?}` (readiness pass): runs `scanFolder` (copy of `cloud/src/scan.ts` plus a `bht_` workspace-token rule; drift checked in CI) locally, then remote `host_data_check {app, env, scan}` with 180 s timeout.
  - `host_init {dir?}`: `initProject(root, BASALT_REGISTRY_URL || rootDomain)` (accepts a full registry URL since the readiness pass); replies Written/Kept and next step `npm install @basalt/api @basalt/auth && npm install -D @playwright/test@~1.64.0`.
- Pack exclusions (always, plus `.gitignore`): `node_modules/`, `.git/`, `.basalt/`, `.env`, `.env.*`, `.npmrc`, `dist/`, `build/`, `coverage/`, `test-results/`, `playwright-report/`, `.DS_Store`, `*.log`, `.e2e-app/`; symlinks skipped; requires `package.json`; tar gzip portable no-follow; >50 MiB → error.
- Init files (never overwrite): `.npmrc` append `@basalt:registry=https://registry.<root>/` if missing; `basalt.json` `{"backend":{"entry":"server/index.ts"},"frontend":{"output":"dist"}}`; `playwright.config.ts` (testDir `./e2e`, baseURL `BASE_URL` or `http://localhost:5173`); `e2e/home.spec.ts` (only if `e2e/` absent; "home page loads" title check); `.gitignore` appends missing `node_modules/`, `dist/`, `.env*`, `test-results/`, `playwright-report/`.

#### 11. Tests

##### 11.1 Unit/integration test files (vitest; count of `it(`)

| File | Cases | Covers |
|---|---|---|
| `hosting/packages/edge/test/edge.test.ts` | 26 (+2 readiness pass: public Host/origin forwarding) | static (5), proxying (8), private envs (1), abuse protection (4), metrics (1), /_basalt/data (5) |
| `hosting/packages/control/test/units.test.ts` | 9 | upload handling (3), source scanning (1), manifest detection (1), bounded settings (4) |
| `hosting/packages/control/test/data-link.test.ts` | 7 (+1: status/admin/Guard use the env's admin key) | Cloud data project create/delete/rules/dataUrlFor |
| `hosting/packages/browser/test/worker.test.ts` | 3 | session interaction, owner isolation + host refusal, in-host navigation |
| `hosting/packages/egress/test/egress.test.ts` | 3 | private/loopback/metadata/LAN refusal (literal + DNS), non-web ports, public allowed |
| `hosting/packages/mcp/test/pack.test.ts` | 4 (+2: registry URL init, local data scan) | pack exclusions, init without overwrite |
| shared | 0 | (`--passWithNoTests`) |
| **Total** | **52** | |

Case titles:
- edge: serves index.html with strict security headers and CSP; falls back to index.html for client-side routes but 404s missing assets; serves precompressed, immutable hashed assets and honors ETags; never serves dotfiles or production source maps, and rejects traversal; refuses writes to static files; signs backend requests verifiably, sets the real client IP and strips spoofed headers; only trusts CF-Connecting-IP from configured proxies; maps /_basalt/auth to the project on the auth service with the forwarded prefix; keeps backend internals private; enforces the body limit; caps concurrent requests per app (bulkhead); wakes sleeping environments on demand; returns 404 for unknown hosts; require a signed access token, exchanged for a cookie via share link; rate limits per IP per app with Retry-After; bans clients probing for exploits, and blocks attack signatures; rejects unusual methods; under-attack mode: challenge for browsers, 403 for scripts, clearance after proof-of-work; records per-host status classes and blocked reasons; forwards data calls to the environment's Data project with the session cookie, never the edge's own cookies; passes uploads, file links and downloads, and keeps the download safety headers; only lets the Data API through, nothing else on the Data service; caps data calls at 256 KB and uploads at 6 MB; is not found for environments without a Data project.
- edge test verifies signatures with `verifyEdgeSignature` from `api/packages/framework/src/edge.ts`.
- control/units: rejects symlinks and drops secrets, dependencies and VCS data; neutralizes path traversal entries; rejects non-gzip and oversized uploads; blocks hardcoded credentials and critical code issues, allows clean code; detects backend, frontend, migrations and e2e by convention; protection and CSP only accept safe values; hostnames are single labels under the root; platform service names (including cloud) are never app names; secrets are bound to their owner (AAD mismatch throws).
- control/data-link: creates a data project bound to the environment's Auth project; says plainly when Cloud refuses, never trusts a malformed project id; deletes by environment id, counts "already gone" as done, reports real failures; falls back to the recorded project id; test environments get rules right away, production waits for owner; points the edge at the data project or nowhere.
- browser: opens a session on a platform host, interacts by role/label, captures console and network problems; isolates sessions between owners and refuses non-platform hosts; only navigates within the session host.
- egress: refuses private, loopback, metadata and LAN destinations (literal and via DNS); refuses non-web ports (no SMTP relaying); allows public destinations.
- mcp: never uploads secrets, dependencies, VCS data or build output; init writes conventions without overwriting.

##### 11.2 `hosting/scripts/e2e-platform.mjs`

- Prereqs: platform up with `docker-compose.yml` + `docker-compose.local.yml`; reads `hosting/deploy/.env` (ROOT_DOMAIN, POSTGRES_PASSWORD); `BASALT_HOST_TOKEN` env; imports `scaffold` from `api/packages/mcp/dist/scaffold.js`.
- App `todo<5 base36 chars>` generated in `hosting/.e2e/<APP>`: scaffolded `server/routes/todos.ts`, `db/migrations/001_todos.sql`; `server/index.ts` with `/probe` route (fetches `http://169.254.169.254/latest/meta-data/`, `http://basalt-control:4001/internal/routes`, `https://example.com/`, checks `E2E_SECRET === 'sesame'`); `package.json` (deps `@basalt/api ^0.1.0`, `@basalt/auth ^0.1.0`, dev `@playwright/test ~1.64.0`, `build: node build.mjs`); `build.mjs` (hashed asset); `src/index.html`, `src/app.js`; `e2e/todos.spec.ts` (2 tests).
- Agent: spawns `hosting/packages/mcp/dist/main.js` over stdio with `BASALT_HOST_URL=http://127.0.0.1:4000`, `BASALT_ROOT_DOMAIN`, `BASALT_PROJECT_DIR`; tool timeout 300 s. Public edge probed at `127.0.0.1:8080` with Host header.
- `E2E_QUICK` mode: create app, deploy, wait, delete, print delete time, exit.
- On failure: `host_delete_app` cleanup; always removes app dir; exit code 1 on failure.

`ok(...)` checks: 47 since the readiness pass (data guide, status, data map, admin approval, Guard + local scan and receipt were added; origins use the demo address). The full ordered list is in WORKLOG.md §10.

- Data checks use sign-in via `/_basalt/auth/signin` (cookie `__Host-basalt_at`), `origin` header, `x-basalt-access` share token; CSRF check uses origin `https://evil.example` → 401.
- Final line: `ALL PLATFORM E2E CHECKS PASSED (<t>)`.

#### 12. Notable cross-cutting facts / discrepancies

- ~~Default `BUILD_NETWORK` in config is `basalt-build`~~ and ~~default `INFRA_CONTAINERS` omits `basalt-cloud`~~: both fixed in the readiness pass.
- `routes.sync` exists only in `main.ts` ctx; `admin.ts` builds its own ctx with `routes: {version: 0, bump() {}}` (no-op). The `under-attack` CLI writes `platform_settings` but does not change the running control process's route version, so the edge (which polls with `If-None-Match: <version>` and gets 304) only sees it after the next route bump by the control process. **Fixed in the readiness pass:** control polls `platform_settings` every 3 s and syncs the edge when the value changes.
- Edge listens internal TLS on 443 only because compose sets `INTERNAL_TLS_PORT=443` with `ip_unprivileged_port_start=0`; code default 8443.
- Browser service is on `core` only (no `outbound`); third-party requests go via egress.
- Control API `/v1/apps/:app/sources` is the only REST app endpoint; all other operations are MCP tools.
- The registry publish user `basalt-platform` is the single allowed Verdaccio account (`max_users: 1`).
- e2e runner network contains only the edge (internal), so tests cannot reach the internet or other services.
