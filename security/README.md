# Basalt Security Test Catalogue

The adversarial tests run against Basalt: what each one sends and which weakness it probes. These are attack tests: every one tries to break a security property on purpose. A test "passes" only when the attack is clearly refused; an error, timeout, or odd answer is treated as "could not tell", never as a pass.

The tests run in CI against a real database (and, for Cloud, real Basalt Auth). "Already tested today" below names the test behind each check, so you can find and run any of them. Guard (`cloud/src/guard.ts`) also attacks every app's live data on each deploy and writes the owner a safety receipt.

Later on the page: what each check sends and which weakness it probes, and an OWASP ZAP comparison of a plain AI-built app with a Basalt app.

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

Almost every check in the catalogue below already runs in these suites. Test names are quoted so you can find them; data tests are in `data/test/attacks.test.ts` unless another file is named.

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

---

## Check catalogue

What each check sends and which weakness it probes, grouped by what it targets. Most of them already run in the in-repo suites (see "Already tested today" above). They describe person A and person B, two signed-in users, plus a stranger with no login.

### Identity: forging or breaking the login token

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

### Isolation: one user reaching another's data

The core promise. Person B, fully logged in as themselves, tries to touch person A's records. Run once per table.

| Check | What it tries | Weakness probed |
| --- | --- | --- |
| get | Open A's record by its id | Object-level access control (IDOR) |
| list | List the table and look for A's rows | Queries missing an ownership clause |
| update | Edit A's record (then re-read it to confirm nothing changed) | Write access control, and refusals that still write |
| archive | Archive/delete A's record | Delete access control |
| fake-owner | Create a record with `owner_id` set to A | Mass assignment of the ownership field |

### Escalation: gaining more power than granted

| Check | What it tries | Weakness probed |
| --- | --- | --- |
| self-admin | Call the admin-grant routes on yourself | Missing authorization on privileged actions |
| role-claim | Put `role: admin` inside your own token | Servers that trust claims in the token instead of the database |
| immutable owner_id / id / archived_at | Rewrite these system columns through a normal update | Protected fields writable via mass assignment |

### Injection: smuggling code or extra fields in

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

### Files: uploads and downloads

| Check | What it tries | Weakness probed |
| --- | --- | --- |
| other-file | Get a download link to another user's file | File access control |
| svg / html | Upload a script-bearing SVG or an HTML page | Stored XSS through served files |
| polyglot | Upload HTML bytes labelled `image/png` | Content-type lying past a type allowlist |
| traversal | Upload under a `../../../etc/passwd` filename | Writing outside the upload area |
| ticket-guess | Download with a random/guessed link token | Guessable download links |
| headers | Inspect a real download's response headers | Downloads that render instead of attaching (missing `nosniff`, CSP) |

### Transport: the HTTP layer

| Check | What it tries | Weakness probed |
| --- | --- | --- |
| csrf-origin / csrf-no-origin | A cookie-authenticated call from another origin, and with no Origin header | Cross-site request forgery |
| cors | A preflight from a hostile origin | CORS that reflects any origin with credentials |
| error-leak | Trigger an error and read the body | Database/stack internals in error messages |
| body-cap | Post an oversized body | Memory exhaustion |
| bad-json | Post malformed JSON | Parser crashes / 500s |
| unknown-route | Hit undeclared and `../`-normalised routes | Hidden or debug endpoints |
| hsts | Read the `Strict-Transport-Security` header over HTTPS | Downgrade to plain HTTP |

### Limits: flooding the service

| Check | What it tries | Weakness probed |
| --- | --- | --- |
| rate | A burst of rapid calls | Missing rate limiting (scraping, brute force, cost blow-ups) |
| retry-after | Read the `Retry-After` header on a 429 | Clients that retry in a tight loop and worsen an outage |

---

## Black-box testing with OWASP ZAP

Run on Sun Oct 25, 2026 with ZAP 2.17.0, on one laptop. Results are under "Results" below.

We compare two salon booking apps that Claude Code built from similar one-sentence prompts:

- **Vibe-coded app:** built by an AI coding assistant on its own. The app handles its own logins and data.
- **MCP-connected vibe-coded app:** the same prompt, built with the Basalt MCP connector, so logins and data go through Basalt.

To keep the comparison fair, both apps get the same ZAP version and settings and the same scans. The vibe-coded app is an Express server with a SQLite file in its folder; the Basalt app is Fade and Co on the local Basalt platform. The Basalt app was scanned from inside Basalt's own network so the scanner had its own address and couldn't get the presenter's laptop banned.

### Scans

| Scan | What it does | What it can find |
| --- | --- | --- |
| Baseline | Crawls the app and reads its responses without attacking | Missing security headers, weak cookie settings, information leaks |
| Full active scan | Sends attack payloads to every page and parameter the crawler finds | Injection, cross-site scripting, path traversal, server errors |
| API scan | The same attacks, driven from a list of the app's API routes (if the app has an OpenAPI description) | Routes the crawler misses, such as data calls made from JavaScript |
| Access control | ZAP's Access Control add-on, signed in as user A and user B, with rules for which addresses each may reach | One user reaching another user's data |

### What the automated scans won't show

ZAP's baseline and active scans look for generic web weaknesses. They don't sign in as two people and try to open each other's records, which is where the two apps are expected to differ. That needs the access-control scan, set up by hand in ZAP with both test users. ZAP's standard scans also don't forge login tokens; those checks stay in the in-repo suites above.

### Running it

The baseline and full scans run from ZAP's Docker image:

```sh
docker run --rm -v "$(pwd):/zap/wrk" -t ghcr.io/zaproxy/zaproxy:stable zap-baseline.py -t <app URL> -r baseline.html
docker run --rm -v "$(pwd):/zap/wrk" -t ghcr.io/zaproxy/zaproxy:stable zap-full-scan.py -t <app URL> -r full-scan.html
```

`<app URL>` must be reachable from inside the container; for an app on the same machine, use `host.docker.internal` instead of `localhost`. The full scan sends real attacks and can change data, so run it only against test copies with test accounts. The access-control scan is set up in the ZAP desktop app.

### Results

| Scan | Vibe-coded app | MCP-connected vibe-coded app (Basalt) |
| --- | --- | --- |
| Baseline (alerts by risk) | 0 high, 1 medium (no anti-CSRF tokens on forms), 4 low (missing cross-origin and permissions headers) | 0 high, 2 medium (`/sitemap.xml` has no CSP; the app's CSP allows inline styles), 0 low |
| Full active scan (alerts by risk) | 0 high, 2 medium (anti-CSRF), 4 low | 0 high, the same 2 medium, 0 low. Basalt's edge banned the scanner a few minutes in for probing scanner paths. A second run with the scanner on the workspace allowlist, so every attack reached the app, found the same. |
| API scan | Not run: no OpenAPI description | Not run: no OpenAPI description |
| Access control (cross-user access) | Not with ZAP: a script signed in as two customers. Leo's attempts on Ava's booking were refused 7 times; 1 (SQL in the login form) couldn't tell, because the app was rate-limiting during the scan | `demo/attack.js`: 9 of 9 attempts on another customer's booking refused, and the customer's own booking still works |

**What this shows.** Neither app fell to the generic web attacks ZAP knows, and the vibe-coded app also got its per-customer checks right this time. The difference is where the protection lives. In the vibe-coded app it's in code the AI wrote, which the next edit can quietly remove, and every customer's data sits in a `salon.db` file in the app's folder with no per-person rules (Guard's code scan flags exactly that file). In the Basalt app the database enforces who sees what whatever the app's code says, the edge bans a scanner on its own, and every deploy is attacked before it ships.

**Limits of this run.** ZAP's crawler found 7 to 8 pages per app and didn't reach Basalt's data API, which the page calls from JavaScript, so cross-user access was tested with the scripts above instead. Both apps ran on one laptop, not a real server.

**Follow-ups for Basalt:** serve `/sitemap.xml` with the same CSP as other pages, and drop `unsafe-inline` from `style-src` where apps allow it.
