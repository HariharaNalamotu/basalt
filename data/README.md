# Basalt Data block

The only way an app reads or writes its database. The app gets four calls (get, list, create and update) and nothing else: no raw SQL and no delete. Whatever code the AI writes around these calls, it can't read or change rows that don't belong to the logged-in user.

```ts
import { BasaltData, parseContract } from '@basalt/data';

const db = new BasaltData({ connectionString: process.env.BASALT_DATA_URL, contract });
const booking = await db.create(userToken, 'bookings', { service: 'Haircut', starts_at: '2026-10-25T15:00:00Z' });
const mine = await db.list(userToken, 'bookings', { limit: 20 });
```

## How it stays safe

- **The database checks the login itself.** The app passes the user's login token through untouched. Postgres verifies the signature (`basalt.uid()` in `sql/02_identity.sql`). The Data block never has the signing secret, so even a fully hacked Data block can't pretend to be another user.
- **Row rules on every table.** Each table made from the contract gets row level security, forced on, so each user only sees and changes their own rows.
- **A locked down database login.** The Data block's login (`basalt_data`) can't delete rows, create or change tables, switch off row rules, set `id` or `owner_id`, read the signing secret or touch the audit log.
- **Checked twice.** Every value is checked against the contract in code, and the database checks the same limits again with its own constraints.
- **Fails closed.** A missing, expired, forged or `alg: none` token means no access. Any error in the login check also means no access.
- **Damage limits.** Rows read and writes per user per minute are capped, page size is capped at 100 and every query is killed after 3 seconds.
- **Audit log.** Every insert and update is recorded with who did it and which columns changed. Values aren't copied, so customer data doesn't end up in a second place.
- **Errors never leak.** The app gets a plain message and a code (`invalid_input`, `not_found`, `denied`, `rate_limited`, `unavailable`), never raw database errors. Someone else's row and a missing row look the same.

## The contract

`contract.example.json` is the data map: tables, fields and the rules on each field. Plain code in `src/schema.ts` turns it into tables, constraints, row rules, grants and triggers. Fields are private by default.

Field types: `text` (with `maxLength` and `pattern`), `integer` and `number` (with `min` and `max`), `boolean` and `timestamp`. Every table also gets `id`, `owner_id`, `created_at` and `updated_at`, which only the database sets.

## Login tokens

Tokens are HS256 JWTs with `sub` (a user id), `exp`, `aud: "authenticated"` and `role: "authenticated"`, which is what Supabase Auth issues. The secret is shared only by the auth service and the database (`BASALT_JWT_SECRET` here, `GOTRUE_JWT_SECRET` in Supabase Auth).

## Run it

Needs Node 23.6 or newer and Docker.

```sh
cp .env.example .env    # fill in each secret with: openssl rand -hex 32
npm install
npm run db:up           # local Postgres 17 on 127.0.0.1:54329
npm run migrate         # applies contract.example.json
npm test                # attack tests
```

`npm run db:reset` wipes the local database and starts fresh.

## Tests

`test/attacks.test.ts` covers normal use, other users' rows, forged and expired logins (wrong secret, `alg: none`, no expiry, a hash of the user id, a swapped payload), SQL injection in values, table names, ids and cursors, mass assignment of `owner_id`, `__proto__`, contract violations, damage limits and a fully taken over Data block running raw SQL.

## Not done yet

- Changing a table after it exists (the migrate step only creates tables today)
- Sharing rows between users, like staff seeing their assigned bookings
- Damage limits shared across several app servers (they're per process today)
