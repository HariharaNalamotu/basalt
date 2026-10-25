# Basalt — Security Test Catalogue

The adversarial tests run against Basalt: what each one sends and which weakness it probes. These are attack tests — every one tries to break a security property on purpose. A test "passes" only when the attack is clearly refused; an error, timeout, or odd answer is treated as "could not tell", never as a pass.

The tests live in two places:

- **In-repo attack suites** that run in CI against a real database (and, for Cloud, real Basalt Auth).
- **A standalone black-box tester** (`basalt-tester.mjs`) that fires the checks below at a running Basalt data API as two separate people plus an unauthenticated stranger.

Each check is tagged with its OWASP ASVS section, the standard CASA is based on.

---

## In-repo attack suites

| Area | Location | What it attacks | Count (per repo) |
| --- | --- | --- | --- |
| Data block | `data/test/attacks.test.ts` | Ownership, token forgery, injection, damage limits, revocation, files, sharing, migrations | 104 attack + feature tests |
| Cloud + Guard | `cloud/test/` | Per-app isolation, approval flow, the Guard access-control probe, the code scan | 49 tests |
| Auth | `auth/packages/server/test/` | Sign-up, sign-in, sessions, MFA, password reset, HTTP hardening | — |
| API framework | `api/packages/framework/test/` | Edge enforcement, auth-by-default, `ctx.sql` ownership, SSRF, abuse | — |
| Hosting edge | `hosting/packages/edge/test/` | Static serving, proxy signing, abuse protection, the data route | — |

Run: `cd data && npm test` (also `cloud`, `auth`, `api`, `hosting`).

---

## The black-box attack tester

`basalt-tester.mjs` signs in as person A and person B (and a stranger with no login) and tries, from the outside, to reach data that isn't theirs or to subvert the API. Grouped by what each attack targets.

### Identity — forging or breaking the login token

An attacker who can get a bad token accepted becomes someone else without a password. These probe the token check from every angle.

| Check | What it sends | Weakness probed |
| --- | --- | --- |
| no-token | A request with no login at all | Unauthenticated access |
| garbage | A random string as the token | Token parsing |
| alg:none | A token with the signature dropped and algorithm set to "none" | Verifiers that trust the token's own algorithm field |
| forged-sig | A token re-signed with the wrong key | Whether the signature is actually verified |
| payload-swap | Another user's id spliced in, keeping the original signature | Whether the signature covers the payload |
| expired | A token whose expiry has passed | The expiry check |
| no-exp | A token with the expiry claim removed | Tokens that never die |
| future-iat | A token dated in the future | Clock-skew tricks to extend a token's life |
| string-exp / frac-exp | Expiry sent as text, or as a fraction | Loose type/rounding comparisons in the expiry check |
| long-life | A token asking for a 400-day lifetime | The maximum-lifetime limit |
| non-canonical | A signature re-encoded so its bytes match but its text differs | String-equality shortcuts in signature checks |
| zero-id | The all-zero user id | A default/null user that could own orphaned rows |

### Isolation — one user reaching another's data

The core promise. Person B, fully logged in as themselves, tries to touch person A's records. Run once per table.

| Check | What it tries | Weakness probed |
| --- | --- | --- |
| get | Open A's record by its id | Object-level access control (IDOR) |
| list | List the table and look for A's rows | Queries missing an ownership clause |
| update | Edit A's record (then re-read it to confirm nothing changed) | Write access control, and refusals that still write |
| archive | Archive/delete A's record | Delete access control |
| fake-owner | Create a record with `owner_id` set to A | Mass assignment of the ownership field |

### Escalation — gaining more power than granted

| Check | What it tries | Weakness probed |
| --- | --- | --- |
| self-admin | Call the admin-grant routes on yourself | Missing authorization on privileged actions |
| role-claim | Put `role: admin` inside your own token | Servers that trust claims in the token instead of the database |
| immutable owner_id / id / archived_at | Rewrite these system columns through a normal update | Protected fields writable via mass assignment |

### Injection — smuggling code or extra fields in

| Check | What it sends | Weakness probed |
| --- | --- | --- |
| filter (×3) | `' OR '1'='1`, a DROP TABLE, a UNION from the auth table, inside a filter value | SQL built by string concatenation |
| table-name | SQL inside the table name | Identifiers pasted into queries |
| catalog | A request to read the database's own `pg_authid` | Reading internal/credential tables |
| bad-id | SQL inside a record id | Ids used unparameterized |
| sort | A SQL expression as the sort column | ORDER BY injection (parameters can't guard it) |
| cursor | A forged or malformed pagination cursor | Cursors decoded and trusted |
| proto | `__proto__` / `constructor` in the body | Prototype pollution |
| unknown-field | An undeclared field in the body | Mass assignment |
| raw-route | A request to a `/sql`-style endpoint | A hidden raw-query or delete endpoint |
| page-cap | A request for 100,000 rows | Dumping a whole table in one call |

### Files — uploads and downloads

| Check | What it tries | Weakness probed |
| --- | --- | --- |
| other-file | Get a download link to another user's file | File access control |
| svg / html | Upload a script-bearing SVG or an HTML page | Stored XSS through served files |
| polyglot | Upload HTML bytes labelled `image/png` | Content-type lying past a type allowlist |
| traversal | Upload under a `../../../etc/passwd` filename | Writing outside the upload area |
| ticket-guess | Download with a random/guessed link token | Guessable download links |
| headers | Inspect a real download's response headers | Downloads that render instead of attaching (missing `nosniff`, CSP) |

### Transport — the HTTP layer

| Check | What it tries | Weakness probed |
| --- | --- | --- |
| csrf-origin / csrf-no-origin | A cookie-authenticated call from another origin, and with no Origin header | Cross-site request forgery |
| cors | A preflight from a hostile origin | CORS that reflects any origin with credentials |
| error-leak | Trigger an error and read the body | Database/stack internals in error messages |
| body-cap | Post an oversized body | Memory exhaustion |
| bad-json | Post malformed JSON | Parser crashes / 500s |
| unknown-route | Hit undeclared and `../`-normalised routes | Hidden or debug endpoints |
| hsts | Read the `Strict-Transport-Security` header over HTTPS | Downgrade to plain HTTP |

### Limits — flooding the service

| Check | What it tries | Weakness probed |
| --- | --- | --- |
| rate | A burst of rapid calls | Missing rate limiting (scraping, brute force, cost blow-ups) |
| retry-after | Read the `Retry-After` header on a 429 | Clients that retry in a tight loop and worsen an outage |

---

## Running the tester

```sh
node basalt-tester.mjs --config tester.config.json
node basalt-tester.mjs --config tester.config.json --only isolation,injection
node basalt-tester.mjs --config tester.config.json --json report.json --md report.md
```

The config supplies the API URL and two test logins. A positive control (person A's real token must still work) runs last; if it fails, the config is wrong and the refusals above prove nothing.

---

## ASVS / CASA coverage

Every check is tagged with its OWASP ASVS section. Together the tests exercise ASVS V2 (authentication), V3 (session management), V4 (access control), V5 (validation & injection), V7 (error handling), V9 (communications), V11 (business logic & DoS), V12 (files) and V14 (configuration) — the chapters CASA assesses against.
