# Basalt — Security Test Catalogue

The adversarial tests run against Basalt: what each one sends and which weakness it probes. These are attack tests — every one tries to break a security property on purpose. A test "passes" only when the attack is clearly refused; an error, timeout, or odd answer is treated as "could not tell", never as a pass.

The tests live in two places:

- **In-repo attack suites** that run in CI against a real database (and, for Cloud, real Basalt Auth).
- **A standalone black-box tester** (`basalt-tester.mjs`, **planned, not in the repo yet**) that will fire the checks below at a running Basalt data API as two separate people plus an unauthenticated stranger.

---

## In-repo attack suites

| Area | Location | What it attacks |
| --- | --- | --- |
| Data block | `data/test/attacks.test.ts` | Ownership, token forgery, injection, damage limits, revocation, files, sharing, migrations |
| Cloud + Guard | `cloud/test/` | Per-app isolation, approval flow, the Guard access-control probe, the code scan |
| Auth | `auth/packages/server/test/` | Sign-up, sign-in, sessions, MFA, password reset, HTTP hardening |
| API framework | `api/packages/framework/test/` | Edge enforcement, auth-by-default, `ctx.sql` ownership, SSRF, abuse |
| Hosting edge | `hosting/packages/edge/test/` | Static serving, proxy signing, abuse protection, the data route |

Run: `cd data && npm test` (also `cloud`, `auth`, `api`, `hosting`). Each suite prints its own count; see the repo README for how to run them.

### Already tested today

Most of the checks in the planned tester below already run in these suites. Test names are quoted so you can find them; data tests are in `data/test/attacks.test.ts` unless another file is named.

| Check | Where it runs today |
| --- | --- |
| no-token, forged-sig, alg:none, expired | "no token", "token signed with the wrong secret", "alg none token", "expired token" |
| payload-swap, no-exp, future-iat, long-life | "payload swapped to another user keeps the old signature", "token with no expiry or no issued-at time", "token issued in the future", "token that lives longer than allowed" |
| string-exp / frac-exp, zero-id, non-canonical | "expiry written as a string", "fractional expiry and the all-zero user id are refused", "a token with a different spelling of the same signature is refused" |
| role-claim | "a service or admin role claim gets nothing" |
| get, list, update, archive | "bob cannot read alice's booking...", "bob's list never includes alice's rows", "bob cannot update alice's booking", "nobody can archive someone else's row" |
| fake-owner, immutable owner_id / id / archived_at | "setting owner_id to someone else is refused", "changing owner_id or id on update is refused", "archived_at cannot be set through a normal update" |
| filter injection | "SQL in a value is stored as plain text" (one payload, not three) |
| table-name, bad-id, sort, cursor | "SQL in a table name is refused", "SQL in an id is refused", "bad filters and sorts are refused", "a forged page cursor is refused" |
| proto, unknown-field, raw-route, page-cap | "__proto__ and unknown fields are refused", "unknown routes, like a raw SQL or delete endpoint, get 404", "page size is capped" |
| catalog (`pg_authid`) | Guard's "Reading the database's own tables" (`cloud/src/guard.ts`) |
| other-file, ticket-guess | `data/test/files.test.ts`: "someone else can't get a link to my file, and made-up links don't work" |
| svg / html, polyglot, traversal, headers | `data/test/files.test.ts`: "file types that can run code, like SVG, HTML and programs", "a web page pretending to be an image", "file names are cleaned", "an image goes up and comes back byte for byte, with safe headers" |
| csrf, cors, error-leak | "is refused from another site (CSRF) or without an Origin", "browsers get CORS headers and preflight works", "errors never include database details" |
| body-cap, bad-json, unknown-route | "oversized and non-JSON bodies are refused", "unknown routes, like a raw SQL or delete endpoint, get 404" |
| rate | "limits are enforced in the database, across every service instance" |
| hsts, retry-after | `hosting/packages/edge/test/edge.test.ts`: "serves index.html with strict security headers and CSP", "rate limits per IP per app with Retry-After" |
| self-admin | Partly: "the Data service's login cannot make anyone an admin". Admins are only added through the owner's approval page. |

Guard (`cloud/src/guard.ts`) also runs the identity and isolation checks against every app's live data on each deploy and writes the owner a safety receipt.

---

## The black-box attack tester (planned)

> **Planned.** `basalt-tester.mjs` is not in the repo yet. This section is its design: it would run the checks below from outside, against any running Basalt. Most of them already run inside the repo today (see "Already tested today" above).

`basalt-tester.mjs` will sign in as person A and person B (and a stranger with no login) and try, from the outside, to reach data that isn't theirs or to subvert the API. Grouped by what each attack targets.

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

## Running the tester (planned)

Once the script lands, the intended usage is:

```sh
node basalt-tester.mjs --config tester.config.json
node basalt-tester.mjs --config tester.config.json --only isolation,injection
node basalt-tester.mjs --config tester.config.json --json report.json --md report.md
```

The config will supply the API URL and two test logins. A positive control (person A's real token must still work) will run last; if it fails, the config is wrong and the refusals above prove nothing.
