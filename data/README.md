# Basalt Data block

The only way an app reads or writes its database. App code gets four calls (get, list, create and update) over HTTP and nothing else: no raw SQL, no delete and no database login. Whatever code the AI writes around these calls, it can't read or change rows that don't belong to the logged-in user.

```ts
import { createBasalt } from '@basalt/data/client';

const basalt = createBasalt({ url: 'http://127.0.0.1:8787', token: () => session.accessToken });
const booking = await basalt.data.create('bookings', { service: 'Haircut', starts_at: '2026-10-25T15:00:00Z' }, { key: 'checkout-42' });
const mine = await basalt.data.list('bookings', { limit: 20 });
```

## How it fits together

```
app code (AI written) --HTTP + user token--> Data service --basalt_data login--> basalt.api() in Postgres --> tables
  holds: a URL                                 holds: a login that can            verifies the token,
                                               only call basalt.api()             charges limits, runs as the user
```

## How it stays safe

- **App code never gets a database login.** It talks to the Data service over HTTP (`src/server.ts`), which only offers get, list, create and update.
- **One door in the database.** The Data service's login (`basalt_data`) can call `basalt.api()` and nothing else: no table, no other function, no other schema. `basalt.api()` (`sql/04_api.sql`) runs as `basalt_exec`, a role nobody can log in as, and only ever touches tables and columns listed in the registry that migrate writes from the contract.
- **The database checks the login itself.** The user's token is passed through untouched and Postgres verifies the signature (`basalt.uid()` in `sql/02_identity.sql`). The Data service never has the signing secret, so even if it's fully taken over it can't pretend to be another user.
- **Strict token rules.** HS256 only, exact base64url, `exp` and `iat` required as whole numbers, a maximum lifetime (1 hour by default), `aud` and `role` must be `authenticated` and the issuer is checked when set. Expiry is checked against each statement's time, so a long running transaction can't keep using an expired token.
- **Log out everywhere.** `select basalt.revoke_user('<user id>')` (admin or auth service only) kills every token that user already has, right away.
- **Row rules on every table.** Each table made from the contract gets row level security, forced on, so each user only sees and changes their own rows. Policies and grants are rebuilt from scratch on every migrate, so a stale or sneaky one can't survive.
- **Sharing without handing over control.** A table can name a `user` field in `shareWith` (the example shares a booking with its `staff_id`). That user can read the row but only the owner can change it.
- **A locked down database login.** Besides having no table access, `basalt_data` can't use temp tables, other databases, large objects, advisory locks, sleep or session signals, and has timeouts on statements, transactions, locks and idle sessions.
- **Checked twice.** Values are checked against the contract in code and again by database constraints. Text formats come from a fixed list (email, phone, url, postal_code, slug) that runs in linear time, so a crafted pattern can't hang the server.
- **Fails closed.** Anything wrong with a login means no access. Errors in the login check never grant access.
- **Damage limits nobody can skip.** Rows read and writes per user per minute are counted inside `basalt.api()`, before the operation runs. The cost is decided by the database, failed requests still count, and the limit holds across every Data service instance, even for someone who took over the Data service.
- **Retries don't duplicate.** Pass a `key` to create and sending it again returns the first row instead of making a new one.
- **Audit log.** Every insert and real change is recorded with who did it and which columns changed, never the values. It's partitioned by month so old months can be dropped cheaply.
- **Errors never leak.** Callers get a plain message and a code (`invalid_input`, `not_found`, `denied`, `rate_limited`, `unavailable`), never database details. Someone else's row and a missing row look the same.
- **The service protects itself.** Request bodies are capped at 64 KB, the token's shape is checked before any body is read, slow bodies are cut off, big pages are trimmed to fit and it sheds load with a 503 when too many requests are in flight.

## Scaling

- One round trip per request: a single autocommit call to `basalt.api()`. No locks are held across network waits, and it works with PgBouncer transaction pooling.
- The Data service keeps no state, so you scale it by running more copies behind a load balancer. Damage limits live in Postgres, so they hold across all of them.
- Each user's "newest first" list uses one index (`owner_id, created_at desc, id desc`) with cursor pagination, so pages stay fast at any table size. Shared tables get a matching index on the share field, and a list runs one indexed scan on each and merges them, so it stays fast however many rows a user can see.
- The login check runs once per call. Inside a call, a note sealed with the secret skips repeat checks for the row rules, defaults and audit trigger.
- The usage counter table is unlogged, so it adds no write ahead log traffic, and old counters are pruned automatically.

Local load test on a laptop with Postgres in a 2 CPU Docker VM, a 70/20/10 read, create and update mix and 2,000 users: at 16 concurrent users 775 to 865 operations a second across runs (each one or two HTTP requests) with zero errors, 17 to 19 ms median and under 50 ms p99, with 200,000 to 600,000 rows in the table. The limit was the laptop: Postgres used both VM CPUs and the load generator shares one Node process with the server. Run it on a fresh database: `npm run db:reset && node --env-file=.env bench/load.ts 8 16`.

## The contract

`contract.example.json` is the data map: tables, fields and the rules on each field. Plain code in `src/schema.ts` turns it into tables, constraints, row rules, grants, triggers and the registry entry `basalt.api()` reads.

Field types: `text` (with `maxLength` and `format`), `integer` and `number` (with `min` and `max`), `boolean`, `timestamp` and `user` (another user's id, for `shareWith`). Every table also gets `id`, `owner_id`, `created_at` and `updated_at`, which only the database sets.

`npm run migrate` creates new tables and can add new optional fields to existing ones. Removing a field, making it required, changing its rules or changing who a table is shared with is refused, because existing data might not fit.

## Login tokens

Tokens are what Supabase Auth issues: HS256 JWTs with `sub` (a user id), `iat`, `exp`, `aud: "authenticated"` and `role: "authenticated"`. The secret is shared only by the auth service and the database (`BASALT_JWT_SECRET` here, `GOTRUE_JWT_SECRET` in Supabase Auth). Set `BASALT_JWT_ISSUER` to the auth service's issuer to check it too.

## Run it

Needs Node 23.6 or newer and Docker with Compose.

```sh
cp .env.example .env    # fill in each secret with: openssl rand -hex 32
npm install
npm run db:up           # local Postgres 17 on 127.0.0.1:54329
npm run migrate         # applies contract.example.json
npm run serve           # Data service on 127.0.0.1:8787
npm test                # resets the local database, then runs the attack tests
```

`npm run db:upgrade` re-applies the security SQL in `sql/` to an existing database (every file is safe to run again, and data and limits are kept). `npm run db:reset` wipes the local database and starts fresh.

## Tests

`test/attacks.test.ts` (68 tests) covers normal use; other users' rows; forged logins (wrong secret, `alg: none`, missing `exp` or `iat`, too long a lifetime, issued in the future, string or fractional expiry, a hash of the user id, a swapped payload, a service role claim, the all-zero user id, padded, spaced or second-spelling encodings, an old transaction outliving its token, a leftover verified-login note); revocation, including old snapshots and cutoffs that must only move forward; SQL injection in values, table names, ids, keys and cursors; mass assignment of `owner_id` and `request_key`; contract violations caught by the code and by the database; every text format behaving the same in JavaScript and Postgres; damage limits that count failed requests and can't be skipped by calling the database directly; idempotent creates; read-only sharing and paging through own plus shared rows; the audit log, including a missed month's partition; migrations (removing a planted policy, adding an optional field, refusing removals, required fields, rule changes, share changes and tables Basalt didn't make, and a field named `constructor`); a fully taken over Data service trying raw SQL; and the HTTP layer (no login, a bad token refused before the body is read, unknown routes, oversized and non-JSON bodies, no leaked details, big pages trimmed without losing rows, load shedding).

## Rotating the secret or issuer

Upgrades never change the signing secret or issuer once they're set, so an old environment can't undo a rotation. To rotate, run as admin: `update basalt.settings set jwt_secret = '<new secret>'` (and the same in the auth service). Every existing token stops working at once.

## Known limits

These only matter if someone takes over the Data service itself and its database login. They still can't read or change any row without a valid token for its owner, but:

- **Damage limits:** wrapping `basalt.api()` in their own transaction and rolling it back undoes the charge. Counting that would need a charge that commits on its own outside the call.
- **Load:** the login's timeouts and memory limits are defaults the session can change, and it can run heavy SQL that touches no table. Postgres has no per role ceiling for these, so real protection here comes from infrastructure: PgBouncer in front of the database, connection limits, or a separate database per app.

Other limits:

- Some changes to an existing table (removing a field, making it required, changing its rules) need a hand written migration.
- Sharing is read only and with one user per row.
- Upgrades start from this version. A database from an earlier draft keeps its old audit table as `audit_before_partitioning`, and tables made before the registry existed are refused by migrate.
