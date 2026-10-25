<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="design/logo/basalt-mark-dark.svg">
    <img src="design/logo/basalt-mark-light.svg" alt="Basalt" width="88">
  </picture>
</p>

<h1 align="center">Basalt</h1>
<p align="center"><b>Build anything. Leak nothing.</b><br>Built at Cal Hacks 13.0</p>

People with no coding experience build apps in their own Claude Code, the normal way. Basalt sits underneath and enforces the ground rules, so nothing the AI writes can leak one customer's data to another. There's no AI inside Basalt: the rules are fixed and checked the same way every time.

**Who it's for.** The owner of a small business who can't code but now can build with AI: a gym owner who wants members to book class spots, a salon taking appointments, a tutor keeping private session notes, a studio logging staff expenses. We had Claude build each of these on Basalt from one sentence. Their customers trust them with names, phone numbers and bookings. The owner can't read the code Claude writes, so they can't tell whether one customer could see another's data, and the next change Claude makes could quietly break it. Basalt makes that the database's job instead of the code's, so the owner doesn't have to check.

**See it for yourself:** [`demo/`](demo/README.md) has a script you paste into the browser console on a live Basalt app. Signed in as one customer, it tries 9 ways to reach another customer's booking from inside the app's own page, with that customer's real login, and shows every result on screen. The stage demo runs it on Pulse, a gym class booking app Claude built on Basalt from one sentence: Leo tries to reach Ava's booking and all nine attempts are refused, while his own booking still works.

## The parts

| Folder | What it is | Who |
| --- | --- | --- |
| [`auth/`](auth/README.md) | Basalt Auth: sign up, sign in, sessions, MFA. Issues the login tokens everything else checks. | Hari |
| [`api/`](api/README.md) | Basalt API: the backend framework apps use (`ctx.sql`, `ctx.data`), with auth and limits built in. | Hari |
| `hosting/` | Basalt Host: build, test, preview and ship apps on one machine, driven by Claude through `host_*` tools. | Hari |
| [`data/`](data/README.md) | The Data block: Postgres where every request is checked inside the database (row rules, login check, damage limits, audit log). | Mihir |
| [`cloud/`](cloud/README.md) | Basalt Cloud: one locked down database per app, the owner's approval pages, data map and Guard (the safety check and receipt). | Mihir |
| [`demo/`](demo/README.md) | The attack demo: try to break a live Basalt app from inside its own page. | Mihir |
| [`design/`](design/README.md) | The black and silver design system and logo used on every owner page. | Mihir |
| [`security/`](security/README.md) | The security test catalogue: every attack Basalt is tested against, and the test that runs it. | Kushaal |

## How a request flows on a hosted app

1. The app's page calls `basalt()` (from `basalt.js`) and asks its own site for `/_basalt/data/...`, carrying only the signed-in person's cookie.
2. Basalt Host's edge forwards only the Data routes to that environment's Basalt Cloud data project.
3. The Data block hands the request to one locked function in Postgres, which checks the login token from Basalt Auth and only ever touches that person's rows (or rows shared with them).

The app's own backend can do the same through `ctx.data` in the API framework.

## Where Claude sits, and where it can still go wrong

Claude Code builds the app, in the person's own Claude Code, through Basalt's tools. Claude is never inside Basalt: it never gets a database login, every read and write goes through the one locked function above, and the rules come from a fixed contract (`basalt.data.json`) that Basalt checks the same way every time. Anything that shows data to more people waits for the owner's plain-English yes, and Guard attacks every deploy before it can ship.

What Basalt doesn't solve, said plainly:

- **The owner's own agent can approve its own change.** The approval link goes back to Claude so it can show it to the owner. If the owner lets Claude open it, Claude can say yes for them. Approval stops app code and later edits from quietly widening access; it doesn't stop an agent the owner has handed the link to. Next step: send the link only to the owner's email.
- **Basalt guarantees who sees the data, not that the app is right.** Claude can still build the wrong page or a confusing one. In our dress rehearsal Claude's first owner page asked for more rows than the Data block allows, so the owner saw an error; the guide now says so and gives a helper.
- **Data kept outside Basalt isn't protected.** If Claude saves something in the browser or in a file, the database rules can't cover it. Guard's code scan looks for that in the app's folder and lists every place it finds.

## What's built (as of Sun Oct 25)

- **Data block:** get, list (filters, sorting, paging), create, update, archive and restore, file uploads, sharing, owner admins and additive rule changes. 111 attack and feature tests.
- **Cloud:** a database per app, plain-English approval for anything that shows data to more people, the owner's data map, test logins through Basalt Auth and **Guard** (`basalt_check`). Guard scans the app folder for data kept outside Basalt, then signs in as two people and a stranger and tries to reach data that isn't theirs: 11 attacks for a one-table app, 6 more for each extra table and one more when the app stores files. Then it writes a safety receipt for the owner. 56 tests.
- **Auth and hosting joined up:** Cloud apps use real Basalt Auth logins, and sessions Auth ends stop working in the database too. Every hosted environment gets its own Cloud data project, served at `/_basalt/data` on the app's own site. The app's rules live in `basalt.data.json` in its folder: deploys apply them to preview and staging before the app's tests run, and promoting to production stops with the owner's approval link until they tap "Yes". (`host_data_rules` sets them by hand.) After the tests on every deploy, Guard attacks the environment's live data, a failed check stops the deploy and production needs Guard to pass in staging. `host_data_check` runs it on demand and returns the owner's safety receipt.
- Reviewed with Codex in several rounds. Every finding so far was fixed.

## Quick start (Mac or Windows)

One thing to run. It checks Docker, builds and starts Basalt, and opens the **Connect Claude** page, where you download the connector file (`.mcp.json`) for Claude Code.

| Computer | Run | Needs |
| --- | --- | --- |
| Mac | double-click `start-mac.command`, or `./start.sh` in Terminal | Docker Desktop |
| Windows | double-click `start-windows.cmd` (not yet tried on a real Windows machine) | WSL (`wsl --install`) and Docker Desktop with WSL integration turned on |
| Linux | `./start.sh` | Docker Engine with Compose |

Then put the downloaded file in an empty folder for your app as `.mcp.json` (the page shows a command that does it), open Claude Code there and approve the `basalt` server. Claude Code on that computer needs Node.js 24 or newer. Each download makes a new workspace key. `./start.sh --no-build` starts again without rebuilding; `./start.sh --stop` stops Basalt and keeps your apps and data. The owner's dashboard is at the same link (`host_dashboard` gives Claude a fresh one, as does `docker exec basalt-control node dist/admin.js dashboard-link my-apps`).

**Emails:** your apps' customers won't get any emails (sign up codes, password resets) until Basalt has an email key. That key is `RESEND_API_KEY`, an API key from [Resend](https://resend.com), the email service Basalt sends through. Put it in `hosting/deploy/.env` with `MAIL_FROM` set to an address on a domain you verified with Resend, then run `./start.sh --no-build`. Until then Claude reads the codes with `host_test_emails` and gives them to you. This applies to the one laptop setup below too.

## Run it on one laptop (demo)

```sh
cd hosting/deploy
./setup.sh basalt.localhost --local
```

Apps are then at `http://<app>.basalt.localhost:8080`, owner pages at `http://cloud.basalt.localhost:8080` and the control API at `http://127.0.0.1:4000`. The script waits until every service is healthy. Give Docker at least 8 GB of memory first (the local overlay caps builds and tests at 1 GB each, so 4 GB works for one build at a time). On Windows, run this inside WSL2 from a clone made inside WSL2 (a Windows checkout can turn the scripts' line endings into ones bash can't run).

On a real server: `./setup.sh <your-domain> --tunnel <cloudflare-tunnel-token>`, then in the Cloudflare dashboard point the tunnel's public hostnames `<your-domain>` and `*.<your-domain>` at `http://edge:8080`. Nothing else is exposed.

## Connect Claude Code (one connector)

```sh
docker exec basalt-control node dist/admin.js create-workspace <name>
```

This prints a ready `claude mcp add basalt …` command (and the same as `.mcp.json`). It runs `@basalt/host-mcp` from the platform's own registry with `npx`, so there is nothing else to install. That one connector gives Claude every tool: create, deploy, test, stage and ship (`host_*`), drive the app in a real browser (`browser_*`), the per-person data rules, Guard and the owner's approvals (`host_data_*`), and Auth/API guides and code review (`auth_*`, `api_*`). Claude starts with `host_guide { topic: "workflow" }`. See [WORKLOG.md](WORKLOG.md) for everything that was built and how it was verified.

## Tests

End to end on a running local platform (see above), each with a workspace token in `BASALT_HOST_TOKEN`:

```sh
node hosting/scripts/e2e-platform.mjs   # Hari's: build, test, preview, staging, production, security, rollback
node hosting/scripts/e2e-salon.mjs      # a salon app on the Data block: rules, owner approval, two real customers kept apart
```

Unit and integration suites:

```sh
cd data && npm test        # needs Docker (starts its own Postgres)
cd cloud && npm test       # also runs Basalt Auth in-process
cd hosting && npm test     # the browser worker's tests need Playwright's Chromium (npx playwright install chromium)
cd auth && npm test
cd api && npm test
```

## Still open

- Nothing has run on a real server with a domain and Cloudflare tunnel yet. The one-laptop setup above passes both end-to-end scripts and a real-browser check.
- Hosted apps now use one connector. Cloud's standalone `basalt_*` connector remains for apps that aren't hosted on Basalt.
- The demo story: plain vibe coded apps vs Basalt apps. A first test found plain builds got basic per-customer checks right. The pitch is that nothing guarantees it, and later edits can quietly break it, while Basalt's rules sit below the code.
