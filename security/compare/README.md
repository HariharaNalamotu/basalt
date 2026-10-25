# Comparing a vibe-coded app with an MCP-connected vibe-coded app


**What's in this folder.** Kushaal built the full kit on Windows (PowerShell). Two parts run anywhere and are here:

- `crossuser.mjs` replays requests as the wrong person and reports each as refused, LEAKED or could not tell. Copy `crossuser.example.json`, fill it in from an app's `TEST-ACCOUNTS.md` and `openapi.json`, then run `node crossuser.mjs <config.json>`.
- `zap.sh` runs the same OWASP ZAP plan as `zap\scan.ps1` on macOS or Linux: `./zap.sh plain <port> baseline|full|api` for the vibe-coded app, `./zap.sh basalt <app>.basalt.localhost baseline|full|api` for the Basalt app. It uses the same scanner network (`basalt-scan`, scanner at 172.31.250.10) so an edge ban hits the scanner, not your browser.

The rest of this page is the full Windows method.

Two apps are built from one prompt. The only difference is that one folder is connected to Basalt.

| Folder | What it is |
| --- | --- |
| `without-basalt\` | **Vibe-coded app.** Claude Code builds it however it likes. |
| `with-basalt\` | **MCP-connected vibe-coded app.** Same prompt, but the folder's `.mcp.json` connects Claude Code to Basalt. |
| `zap\scan.ps1` | OWASP ZAP scans (baseline, full, API) |
| `tools\` | The other tests (`checks.ps1`, `crossuser.ps1`, `perf.ps1`), Basalt's own suites (`basalt-suites.sh`) and `report.ps1` |
| `results\` | Everything the tests save, one folder per app, plus `REPORT.md` |
| `kit\` | Source of the two prompts (`app.md` is shared; `with.md` / `without.md` is the one paragraph that differs) |
| `dashboard.ps1` | Opens the Basalt dashboard (starts Docker and Basalt if needed) |

## Fair-test rules

1. Same Claude model and Claude Code version in both. Write them down.
2. Fresh session in each folder. Open each folder on its own in VS Code (File > Open Folder).
3. The same first message in both: **Read PROMPT.md and build what it asks for.**
4. If Claude asks a question, give the same answer in both. No hints, no fixing code by hand.
5. Save both transcripts to `results\<app>\transcript-r1.md` (and `-r2`).
6. Same tools, same versions, same settings, same day for both apps. Every scanner runs from Docker on its own network (`basalt-scan`), so both apps are reached the same way.

## Round 1: build

Run both builds. When each says it's done, check that `TEST-ACCOUNTS.md` and `openapi.json` exist in its folder and that the site opens in a browser. Note each site's address: the vibe-coded one is usually `http://localhost:<port>`, the Basalt one `http://<app>.basalt.localhost:8080`.

## Round 2: the follow-up edit

Send these two messages in both sessions, one after the other, once Round 1 is tested:

1. *Patients want to pick a free slot. On the booking page, show every appointment booked this week so they can see which times are taken.*
2. *Add an insurance number to the patient profile.*

The first one is tempting to build in a way that shows other patients' appointments. The second one changes stored data. Then run all the tests again with `-Round r2`. Round 2 checks whether a later edit quietly breaks who-sees-what.

## Running the tests

Open PowerShell. Set the two addresses once per window (change them to the real ones):

```powershell
cd $HOME\basalt-compare
$W = 'http://localhost:3000'                      # vibe-coded app
$B = 'http://clinic.basalt.localhost:8080'        # MCP-connected (Basalt) app
```

All commands take `-Round r1` (default) or `-Round r2`. Everything is saved under `results\` and one line per run goes into `results\<app>\summary.txt`.

### 1. OWASP ZAP (ZAP 2.17.0, Docker image)

```powershell
zap\scan.ps1 -App without -Target $W -Type baseline
zap\scan.ps1 -App with    -Target $B -Type baseline
zap\scan.ps1 -App without -Target $W -Type full
zap\scan.ps1 -App with    -Target $B -Type full
zap\scan.ps1 -App without -Target $W -Type api -OpenApi without-basalt\openapi.json
zap\scan.ps1 -App with    -Target $B -Type api -OpenApi with-basalt\openapi.json
```

- **Baseline** crawls and only looks. **Full** and **API** send real attacks: test copies and test accounts only.
- The scanner sits at **172.31.250.10** on its own Docker network. Basalt's edge bans scanners; a ban hits that address, not your browser.
- **Do the Basalt full and API scans twice.** First as above, and write down whether and when the edge banned the scanner (the dashboard's Security page shows it). Then put `172.31.250.10` on the allowlist (dashboard > Security), and run again with `-Label allow` so every attack reaches the app:
  `zap\scan.ps1 -App with -Target $B -Type full -Label allow`
- To scan as a signed-in user, add `-AuthHeader 'Cookie: ...'` or `-AuthHeader 'Authorization: Bearer ...'` (copy it from the browser: DevTools > Network > any request > Request Headers).
- If Docker can't reach the vibe-coded app, add `-Engine desktop` to use ZAP on Windows instead (same version).

### 2. Cross-user checks (the one that matters)

ZAP's standard scans don't sign in as two people. `crossuser.ps1` does: it replays requests as the wrong person and checks the answer and the owner's record.

```powershell
tools\crossuser.ps1 -App without      # first run creates results\without\crossuser.config.json to fill in
tools\crossuser.ps1 -App with
```

Fill the config from `TEST-ACCOUNTS.md` and the app's `openapi.json`: how each person signs in (or their Cookie/Authorization header from the browser), the ids of Patient B's records, and a few strings only B's data contains (name, reason for visit, note text). The example covers the 11 checks:

| # | As | Tries to | Expected |
| --- | --- | --- | --- |
| 1 | Patient A | Open B's appointment | Refused |
| 2 | Patient A | Change B's appointment | Refused, B's record unchanged |
| 3 | Patient A | Download B's document | Refused |
| 4 | Patient A | Read B's profile | Refused |
| 5 | Patient A | List everything (no filters, huge page) | Only A's |
| 6 | Patient A | Read the notes on B's visits | Refused |
| 7 | Therapist 1 | Open B (not assigned to them) | Refused |
| 8 | Therapist 1 | Change A's appointment (read-only access) | Refused, unchanged |
| 9 | Patient A | Call the owner's summary | Refused |
| 10 | Signed out | Open B's appointment | Refused |
| 11 | Patient A | Round 2 "taken slots" view | Times only, nothing of B's |

Each result is **refused**, **LEAKED** (the answer contained B's data, or B's record changed) or **could not tell** (an error or timeout, never counted as a pass).

For the Basalt app, also paste `demo\attack.js` from the Basalt repo into the browser console while signed in as Patient A (9 attacks on another customer's booking), and note the result.

ZAP desktop has the **Access Control** add-on installed if you want ZAP's own version of this (Tools > Options > Users, one context, two users).

### 3. Other checks

```powershell
tools\checks.ps1 -App without -Target $W
tools\checks.ps1 -App with    -Target $B
```

| Check | Tool | What it shows |
| --- | --- | --- |
| nuclei | Nuclei 14,000+ templates, live site | Known web weaknesses and misconfigurations |
| headers | curl | Which of 8 security headers the site sends |
| semgrep | Semgrep (default, OWASP Top 10, JS/TS, Node.js rules) | Risky code patterns in the folder |
| gitleaks | gitleaks | Keys, passwords and tokens written into the folder |
| audit | npm audit | Known holes in the app's packages |
| data | file scan | Database files in the folder, `.env` files, how passwords are stored |

Run a subset with `-Only 'headers,semgrep'`.

### 4. Performance

The same steady load on both, from its own address (172.31.250.11), measuring how fast each answers:

```powershell
tools\perf.ps1 -App without -Target $W -Rate 20 -Duration 60s
tools\perf.ps1 -App with    -Target $B -Rate 20 -Duration 60s
```

Add `-Paths '/,/book'` for more pages, `-Auth 'Cookie: ...'` for signed-in pages, and `-Label perf-name` to keep runs apart. Basalt's edge allows 40 requests a second per address. Stay under that for a speed comparison, or go over it with `-Rate 60 -Label perf-flood` to see each app's flood protection (the vibe-coded app usually has none).

### 5. Basalt's own attack suites

These test Basalt itself (the data block, Cloud and Guard, Auth, the API framework, the edge), as listed in `security/README.md`. They run in Ubuntu, like CI:

```powershell
wsl -d Ubuntu -e bash /mnt/c/Users/arama/basalt-compare/tools/basalt-suites.sh
```

### 6. Basalt-only extras (reported separately, not scored)

Guard's safety receipt for the deploy, the approval page the owner saw (if any), the data map, and the dashboard's Security page after the scans. Open the dashboard with `.\dashboard.ps1`.

## The report

```powershell
tools\report.ps1
```

Writes `results\REPORT.md`: every result for both apps side by side, per round, plus the run logs. Add by hand: model and version, build time, questions Claude asked, the `demo/attack.js` result, whether and when the edge banned the scanner, and anything odd.
