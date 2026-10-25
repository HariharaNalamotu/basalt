# Basalt Auth

Authentication for apps built on Basalt. It's opinionated and secure by default, and designed so a coding agent can't easily get it wrong.

An app gets email and password sign-up with verification, sign-in, sessions, password reset, TOTP two-factor auth, session management and user administration by installing one SDK and calling a few functions. Passwords, tokens, cookies, rate limits and key management never pass through app code.

```
auth/
  packages/server   @basalt/auth-server   the service (Hono + Postgres + Redis)
  packages/sdk      @basalt/auth          browser client, backend verifier, React bindings
  packages/mcp      @basalt/auth-mcp      MCP tools for coding agents (provision, integrate, review)
  scripts/e2e.mjs   end-to-end checks against real Postgres + Redis
```

## For app developers (and their agents)

```ts
// browser
import { createAuthClient } from '@basalt/auth/client';
const auth = createAuthClient();
await auth.signUp({ email, password });   // -> verification_required
await auth.verifySignUp({ code });         // 6-digit emailed code; now signed in
const user = await auth.getUser();
await auth.fetch('/api/todos');            // call your backend; refreshes automatically

// backend
import { createAuthServer } from '@basalt/auth/server';
const auth = createAuthServer();           // reads env set by the platform
const user = await auth.requireUser(req);  // verified locally; 401 if signed out
db.query('SELECT * FROM todos WHERE owner_id = $1', [user.id]);
```

Agents should call the `auth_integration_guide` MCP tool, which returns complete, tested code for React, Next.js, Express, Hono and native clients. Afterwards they should run `auth_review_code` on what they wrote.

## Database-enforced data ownership

Authentication only says who is asking. Most real breaches in small apps happen afterwards: a query that forgot `WHERE owner_id = ?`, an IDOR, an SQL injection. Basalt Auth extends the session into the app's own Postgres so **the database checks ownership itself**:

1. Every access token carries a **data grant** (claim `bdg`): a compact HS256 JWT signed with the project's own data key, header `{alg: HS256, kid: "v<keyVersion>"}`, payload `{sub, sid, iat, exp, aud: "authenticated", role: "authenticated", iss}`. It is bound to one live session, expires with the access token (at most 1 hour) and is the same token the Basalt Data block (`data/`) checks, so one login works for `ctx.sql`, `ctx.data` and the browser's `/_basalt/data`.
2. `auth_enable_data_protection` installs the `basalt_auth` schema into the app database. It holds the project's grant key, readable only via `SECURITY DEFINER` functions, and a verifier written against built-in `sha256()` (no extensions needed).
3. `SELECT basalt_auth.protect('todos')` turns on forced RLS. `owner_id` then defaults to the verified user, and every read or write is limited to `owner_id = basalt_auth.uid()`.
4. `auth.withUserDb(pool, req, fn)` runs `fn` in a transaction after `basalt_auth.authenticate(grant)`. Postgres checks the signature, project, expiry and revocation list before any row is visible.
5. `auth.startRevocationSync(pool)` pulls revoked sessions (sign-out, password change or reset, disable, delete, theft detection) into the app database every 10 s. A trigger in the auth DB records every way a session can end, so no code path can forget.

Properties (each is a test in `packages/server/test/data-protection.test.ts`, plus `scripts/e2e-data.mjs` on real Postgres):

| Attack | Result |
|---|---|
| Unfiltered `SELECT * FROM todos` | Only the caller's rows. |
| `INSERT ... owner_id = <someone else>` | Rejected by the RLS `WITH CHECK`. |
| `UPDATE`/`DELETE` without a WHERE clause | Affects only the caller's rows. |
| No grant (forgot `withUserDb`) | Zero rows; writes fail. Fail-closed. |
| Tampered user id, bad signature, other project's grant, expired grant | `28000` error before any row is read. |
| Stolen cookie used after sign-out | Rejected once revocations sync (≤10 s). |
| Compromised app server or SQL injection | Can use grants for users currently making requests, but can't mint grants, read the key, or disable RLS. |
| App misconfigured with the admin/superuser role | The SDK refuses to run in production and warns in development. |

Patterns for shared data (public reads, teams, admins) and Prisma/Drizzle usage are in the `database` integration guide.

**Platform requirement:** provision each app database with two roles, an admin/migration role that owns the schema and a restricted runtime role for `DATABASE_URL` (not superuser, no `BYPASSRLS`, not a table owner). Implement `installDataProtection` in the MCP control plane so the install SQL (which contains the key) never passes through the agent.

## Step-up re-authentication

Tokens carry `auth_time`. Backends call `auth.requireUser(req, { maxAgeSeconds: 300 })` before sensitive actions (payments, deleting data, changing roles), which returns 403 `reauthentication_required` when the proof is stale. The client calls `auth.reauthenticate({ password, code? })`, which requires the second factor when MFA is enabled, and retries. Other Basalt features can rely on the same claim.

## Security model

| Threat | Mitigation |
|---|---|
| Password database theft | Argon2id (OWASP parameters: m=19 MiB, t=2, p=1) via Node's built-in implementation; transparent rehash when parameters change. |
| Weak or reused passwords | Minimum 10 characters, no composition rules (NIST 800-63B), common-password blocklist, Have I Been Pwned k-anonymity check (fail-open). |
| Credential stuffing / brute force | Per-IP (IPv6 bucketed by /64), per-account+IP (10/15 min) and per-account (50/h) limits, shared via Redis. Hashing concurrency is bounded and sheds load with 503 instead of falling over. |
| User enumeration | Identical responses and equal hashing cost for unknown vs. known emails on sign-in, sign-up and reset request. Existing users get an "account exists" email instead of a code. Known gap: reset confirm answers "too many attempts" only for a real account after 5 wrong codes, so it can reveal that an account exists. |
| Account pre-hijacking | No user row exists until the email is verified. A pending sign-up is bound to the device that started it (`signupToken`), so a code alone can't complete someone else's sign-up. |
| Session theft via XSS | Browser sessions live only in `HttpOnly` cookies (`__Host-` prefixed access cookie, path-scoped `__Secure-` `SameSite=Strict` refresh cookie). Tokens never appear in browser-visible response bodies, and browser requests can't supply a refresh token in the body. |
| CSRF | Browser writes require an allow-listed `Origin` and `application/json` (forcing a CORS preflight). The backend SDK rejects cookie-authenticated writes from foreign origins. The secret-key API refuses any request with an `Origin`. |
| Stolen refresh token | Rotation on every use. A refresh token is `HMAC(per-session secret, generation)`, so replaying any superseded token, however old, is recognized and revokes the whole session (10 s grace for concurrent tabs). Forged tokens are rejected without affecting the real session. Storage is O(1) per session. |
| Token forgery / confusion | Ed25519 (EdDSA) JWTs with per-project keys. Verification pins `alg`, `typ: at+jwt`, issuer and audience, so tokens can't cross projects. |
| Signing key compromise | Private keys encrypted at rest (AES-256-GCM, AAD-bound to key id). Rotation keeps old keys published until their tokens expire. |
| Revocation lag | Access tokens last 10 minutes by default (max 1 h). Auth-service endpoints always check the live session, and the backend SDK offers `{ strict: true }` for instant revocation on high-stakes actions. |
| Code guessing | 6-digit codes, HMAC'd with a server-side pepper (a DB leak doesn't allow offline brute force), 5 attempts per code then burned, single-use, 15–30 min expiry, issuance rate-limited. |
| MFA bypass / replay | TOTP (RFC 6238) with ±1 step drift and last-used-step tracking (no code reuse). Recovery codes are single-use. Password reset and email verification never bypass MFA. |
| Misconfiguration | Every setting is bounded (TTLs, lengths). Origins must be exact https (http only for loopback names: localhost, 127.0.0.1, [::1] and *.localhost). Production refuses to start without Redis, https, secure cookies or a real mailer. |
| Broken object-level authorization in app code | Database-enforced ownership via session-bound data grants and forced RLS (see above). |
| Stale proof for sensitive actions | `auth_time` claim, `maxAgeSeconds`, step-up re-authentication. |
| Cross-tenant access | Every query is scoped by `project_id`. Control-plane calls are scoped to the `X-Basalt-Owner` workspace, and foreign projects are indistinguishable from nonexistent ones. |
| Secret leakage | Secret keys and tokens are stored only as hashes. Logs redact secret-looking fields, Redis rate-limit keys are hashed (no emails or IPs in Redis), and the MCP never shows secrets when the platform stores them. |

There's also an audit log (`auth_events`) recording sign-ups, sign-ins, failures, resets, MFA changes, revocations and refresh-token theft.

## Platform integration contract

These are the pieces the Basalt platform needs to provide. Everything else is inside this service.

**1. Edge routing (same-origin auth).** Route `https://<app-domain>/_basalt/auth/*` to `<auth-service>/v1/projects/<projectId>/*` and set:
- `X-Forwarded-For` (append the client IP) and `X-Forwarded-Prefix: /_basalt/auth`
- `TRUST_PROXY_HOPS` on the auth service to the number of proxies in front of it

Same-origin routing is what lets sessions use first-party `HttpOnly` cookies that the app's own backend also receives. Third-party cookies are blocked by browsers. The SDK defaults to `/_basalt/auth`, so apps need no configuration.

**2. App environment.** Inject into the app's backend: `BASALT_PROJECT_ID`, `BASALT_AUTH_URL` and (secret) `BASALT_AUTH_SECRET_KEY`. Add the app's domains to the project's `allowedOrigins` when deploying.

**3. Email.** Set `MAILER=webhook`, `MAIL_WEBHOOK_URL` and `MAIL_WEBHOOK_SECRET`. The service POSTs `{ projectId, template, to, subject, text }` with header `Basalt-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. Verify the signature and reject timestamps older than 5 minutes.

**4. MCP.** Mount the tools in the platform's MCP server for the authenticated workspace:
```ts
import { registerAuthTools, HttpControlPlane } from '@basalt/auth-mcp';
registerAuthTools(mcpServer, Object.assign(new HttpControlPlane(AUTH_URL, PLATFORM_KEY, workspaceId), {
  // Recommended: write new secret keys straight into the app's secret store, so the agent never sees them.
  storeProjectSecret: async (projectId, key) => { await secrets.put(appFor(projectId), 'BASALT_AUTH_SECRET_KEY', key); return { envVar: 'BASALT_AUTH_SECRET_KEY' }; },
}));
```
The platform key stays on the platform. The agent only ever reaches the tools.

**5. Secrets for the service itself.**
- `BASALT_AUTH_MASTER_KEY`: 32 random bytes, base64. Store it in a KMS or secret manager; it encrypts signing keys and TOTP secrets.
- `BASALT_AUTH_PLATFORM_KEY`: control-plane bearer key, at least 32 characters.

### Configuration

| Variable | Required | Notes |
|---|---|---|
| `PUBLIC_URL` | yes | Public base URL; becomes the JWT issuer prefix. https in production. |
| `DATABASE_URL` | yes | Postgres 14+. Migrations run automatically at boot (advisory-locked, safe with many replicas). |
| `REDIS_URL` | production | Shared rate limits. Without it, limits are per-process (development only). |
| `BASALT_AUTH_MASTER_KEY` | yes | `openssl rand -base64 32` |
| `BASALT_AUTH_PLATFORM_KEY` | yes | At least 32 characters. |
| `TRUST_PROXY_HOPS` | behind proxies | Number of trusted proxies appending to `X-Forwarded-For`. |
| `MAILER`, `MAIL_WEBHOOK_URL`, `MAIL_WEBHOOK_SECRET` | production | `console` is refused in production. |
| `COOKIE_SECURE` | | Default `true`; `false` only for plain-http local dev. |
| `DATABASE_MAX_CONNECTIONS`, `HASH_CONCURRENCY`, `HASH_QUEUE_LIMIT`, `LOG_LEVEL` | | Tuning. |

## Scaling

- **Stateless replicas.** All state is in Postgres and Redis. Scale horizontally behind the edge.
- **Auth stays off the hot path.** Apps verify access tokens locally against a cached JWKS (refetched automatically on key rotation). The auth service handles only sign-ins and a refresh every ~10 minutes per active user.
- **CPU-bound hashing is fenced.** Argon2 runs on the libuv threadpool (`UV_THREADPOOL_SIZE` is set at boot) with bounded concurrency and a bounded queue (503 + `Retry-After` when saturated). Scale on CPU.
- **Write-friendly schema.** UUIDv7 primary keys (index-local inserts) and O(1) refresh-token storage per session. A maintenance sweep (advisory-locked, batched) removes expired codes and sessions, and keeps 1 year of audit events.
- **Hot reads are cached.** Project config (15 s), signing keys and JWKS (60 s) are cached in-process.
- **Ready for transaction-mode PgBouncer.** No session-level state: advisory locks are transaction-scoped.

## HTTP API

Per project, under `/v1/projects/:projectId` (browser path `/_basalt/auth`):

| Method | Path | Notes |
|---|---|---|
| GET | `/.well-known/jwks.json` | Public signing keys (cacheable). |
| GET | `/config` | Public settings for building UI. |
| POST | `/signup`, `/signup/verify`, `/signup/resend` | Sign-up with emailed code. |
| POST | `/signin`, `/signin/mfa` | Password, then TOTP or recovery code if enabled. |
| POST | `/email/verify`, `/email/verification/send` | Verify email for existing accounts. |
| POST | `/password/reset/request`, `/password/reset/confirm`, `/password/change` | |
| POST | `/session/refresh`, `/session/signout`, `/session/reauthenticate` | |
| GET | `/session`, `/sessions` | Current user; active sessions. |
| DELETE / POST | `/sessions/:id`, `/sessions/revoke-others` | |
| POST | `/mfa/totp/enroll`, `/mfa/totp/confirm`, `/mfa/totp/disable`, `/mfa/recovery-codes` | |
| POST | `/account/delete` | Requires the password. |
| * | `/admin/...` | Backend only, `Authorization: Bearer <project secret key>`: users, metadata, disable, delete, revoke, events, `sessions/verify`. |

Control plane, under `/v1/platform` (platform key plus `X-Basalt-Owner`): project CRUD, key rotation, user administration, events, `data-protection/install.sql` and the `data-protection/revocations` feed. The backend reads the same feed with its secret key at `/admin/revocations`.

Errors are always `{ "error": { "code", "message" } }`. Branch on `code`; `message` is safe to show to end users. 429 and 503 include `Retry-After`.

## Development

```bash
cd auth
npm install
npm test                      # server + SDK + MCP suites (real Postgres via PGlite, no Docker needed)
docker compose up -d --build  # Postgres + Redis + auth on :8787 (console mailer: codes appear in logs)
node scripts/e2e.mjs          # end-to-end checks against the real stack
npm run build && node scripts/e2e-data.mjs   # database-enforced ownership on real Postgres
```

## Not yet built

Listed in roughly the order they'd add the most value:
1. **Passkeys (WebAuthn)**: phishing-resistant sign-in and MFA.
2. **OAuth sign-in** (Google, GitHub, Apple) with safe account linking (verified-email matching only).
3. **Drop-in UI components** (`<SignIn/>`, `<SignUp/>`, `<AccountSettings/>`), so agents don't build forms at all.
4. **Email change** flow (verify the new address and notify the old one).
5. **Roles/claims in tokens**: a bounded `claims` field on users, signed into access tokens, so role checks need no lookup.
6. **Bot defense** on sign-up (proof-of-work or captcha hook) and IP reputation.
7. **KMS envelope encryption** for the master key, plus master-key and data-grant-key rotation tooling (grants already carry a key version).
8. **Organizations / teams**, and enterprise SSO (SAML/OIDC).
