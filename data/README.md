# Basalt Data block

The only way an app reads or writes its database. App code gets four calls (get, list, create and update) over HTTP and nothing else: no raw SQL, no delete and no database login. Whatever code the AI writes around these calls, it can't read or change rows that don't belong to the logged-in user.

```ts
import { createBasalt } from '@basalt/data/client';

const basalt = createBasalt({ url: 'http://127.0.0.1:8787', token: () => session.accessToken });
const booking = await basalt.data.create('bookings', { service: 'Haircut', starts_at: '2026-10-25T15:00:00Z' });
const mine = await basalt.data.list('bookings', { limit: 20 });
```

## How it fits together

```
app code (AI written)  --HTTP + user token-->  Data service  --basalt_data login-->  Postgres
   holds: a URL                                  holds: DB login                   holds: signing secret,
                                                 (never the secret)                row rules, audit log
```

## How it stays safe

- **App code never gets a database login.** It talks to the Data service over HTTP (`src/server.ts`), which only offers get, list, create and update.
- **The database checks the login itself.** The user's token is passed through untouched and Postgres verifies the signature (`basalt.uid()` in `sql/02_identity.sql`). The Data service never has the signing secret, so even if it's fully taken over it can't pretend to be another user.
- **Strict token rules.** HS256 only, exact base64url, `exp` and `iat` required as numbers, a maximum lifetime (1 hour by default), `aud` and `role` must be `authenticated` and the issuer is checked when set. Expiry is checked against each statement's time, so a long running transaction can't keep using an expired token.
- **Row rules on every table.** Each table made from the contract gets row level security, forced on, so each user only sees and changes their own rows. Policies and grants are rebuilt from scratch on every migrate, so a stale or sneaky one can't survive.
- **A locked down database login.** `basalt_data` can't delete rows, create or change tables (including temp tables), switch off row rules, set `id` or `owner_id`, read the signing secret, the usage counters or the audit log, connect to other databases, or use large objects, advisory locks, sleep or session signals.
- **Checked twice.** Values are checked against the contract in code and again by database constraints. Text formats come from a fixed list (email, phone, url, postal_code, slug) that runs in linear time, so a crafted pattern can't hang the server.
- **Fails closed.** Anything wrong with a login means no access. Errors in the login check never grant access.
- **Damage limits in the database.** Rows read and writes per user per minute are counted in Postgres, so the limit holds across every Data service instance. Each request is charged in its own statement before it runs, so a request that fails still counts. Page size is capped at 100 and the database login has timeouts on statements, transactions, locks and idle sessions.
- **Audit log.** Every insert and real change is recorded with who did it and which columns changed. Values aren't copied, so customer data doesn't end up in a second place.
- **Errors never leak.** Callers get a plain message and a code (`invalid_input`, `not_found`, `denied`, `rate_limited`, `unavailable`), never database details. Someone else's row and a missing row look the same.
- **The service protects itself.** Request bodies are capped at 64 KB, only JSON is accepted, slow requests time out and it sheds load with a 503 when too many requests are in flight.

## Scaling

- The Data service keeps no state, so you scale it by running more copies behind a load balancer. Damage limits live in Postgres, so they hold across all of them.
- Each user's "newest first" list uses one index (`owner_id, created_at desc, id desc`) with cursor pagination, so pages stay fast at any table size. With 200,000 rows a user's first page takes about 2 ms in the database.
- The login check runs once per statement, not per row. A per transaction note sealed with the secret skips repeat checks (87 µs down to 38 µs).
- Each request is one short transaction with the token set locally, which works with PgBouncer transaction pooling.
- The usage counter table is unlogged, so it adds no write ahead log traffic. Run `select basalt.prune_usage()` from a scheduled job.

Local load test (`node --env-file=.env bench/load.ts 8 16`) on a laptop with Postgres in a 2 CPU Docker VM, 200,000 rows across 2,000 users, 16 concurrent users and a 70/20/10 read, create and update mix: 740 to 1,000 operations a second across runs (each operation is one or two HTTP requests) with zero errors, about 20 ms median and under 50 ms p99. The limit was the laptop: Postgres used both VM CPUs and the load generator shares one Node process with the server.

## The contract

`contract.example.json` is the data map: tables, fields and the rules on each field. Plain code in `src/schema.ts` turns it into tables, constraints, row rules, grants and triggers. Changing a table that already exists is refused for now, so nothing gets half applied.

Field types: `text` (with `maxLength` and `format`), `integer` and `number` (with `min` and `max`), `boolean` and `timestamp`. Every table also gets `id`, `owner_id`, `created_at` and `updated_at`, which only the database sets.

## Login tokens

Tokens are what Supabase Auth issues: HS256 JWTs with `sub` (a user id), `iat`, `exp`, `aud: "authenticated"` and `role: "authenticated"`. The secret is shared only by the auth service and the database (`BASALT_JWT_SECRET` here, `GOTRUE_JWT_SECRET` in Supabase Auth). Set `BASALT_JWT_ISSUER` to the auth service's issuer to check it too.

## Run it

Needs Node 23.6 or newer and Docker.

```sh
cp .env.example .env    # fill in each secret with: openssl rand -hex 32
npm install
npm run db:up           # local Postgres 17 on 127.0.0.1:54329
npm run migrate         # applies contract.example.json
npm run serve           # Data service on 127.0.0.1:8787
npm test                # attack tests
```

`npm run db:reset` wipes the local database and starts fresh.

## Tests

`test/attacks.test.ts` (58 tests) covers normal use, other users' rows, forged logins (wrong secret, `alg: none`, missing `exp` or `iat`, too long a lifetime, issued in the future, string expiry, a hash of the user id, a swapped payload, a service role claim, padded or spaced encodings, a second spelling of the same signature, fractional expiry, the all-zero user id, an old transaction outliving its token, a forged or reused verified-login note), SQL injection in values, table names, ids and cursors, mass assignment of `owner_id`, `__proto__`, contract violations caught by the code and by the database, every text format behaving the same in JavaScript and Postgres, shared damage limits that still count failed requests, the audit log, migrations removing a planted policy and refusing any change to an existing table's columns or rules, a fully taken over Data service running raw SQL, and the HTTP layer (no login, a bad token refused before the body is read, unknown routes, oversized and non-JSON bodies, no leaked details, big pages trimmed without losing rows, load shedding).

## Not done yet

- Changing a table after it exists
- Sharing rows between users, like staff seeing their assigned bookings
- Revoking a token before it expires (today a stolen token works until `exp`, at most one hour)
- Idempotency keys so a retried create can't make a duplicate
- Damage limits bind app code, which only reaches the HTTP service. Someone who takes over the Data service itself and its database login can skip them (they still can't read or change rows without a valid token)
- Security SQL in `sql/` runs on a fresh database only. Upgrading an existing one needs versioned migrations
- Partitioning the audit log by time for cheap retention
