# Basalt

People with no coding experience build apps in their own Claude Code, the normal way. Basalt sits underneath and enforces the ground rules, so nothing the AI writes can leak one customer's data to another. There's no AI inside Basalt: the rules are fixed and checked the same way every time.

## The parts

| Folder | What it is | Who |
| --- | --- | --- |
| [`auth/`](auth/README.md) | Basalt Auth: sign up, sign in, sessions, MFA. Issues the login tokens everything else checks. | Hari |
| [`api/`](api/README.md) | Basalt API: the backend framework apps use (`ctx.sql`, `ctx.data`), with auth and limits built in. | Hari |
| `hosting/` | Basalt Host: build, test, preview and ship apps on one machine, driven by Claude through `host_*` tools. | Hari |
| [`data/`](data/README.md) | The Data block: Postgres where every request is checked inside the database (row rules, login check, damage limits, audit log). | Mihir |
| [`cloud/`](cloud/README.md) | Basalt Cloud: one locked down database per app, the owner's approval pages, data map and Guard (the safety check and receipt). | Mihir |

## How a request flows on a hosted app

1. The app's page calls `basalt()` (from `basalt.js`) and asks its own site for `/_basalt/data/...`, carrying only the signed-in person's cookie.
2. Basalt Host's edge forwards only the Data routes to that environment's Basalt Cloud data project.
3. The Data block hands the request to one locked function in Postgres, which checks the login token from Basalt Auth and only ever touches that person's rows (or rows shared with them).

The app's own backend can do the same through `ctx.data` in the API framework.

## What's built (as of Sat Oct 24)

- **Data block:** get, list (filters, sorting, paging), create, update, archive and restore, file uploads, sharing, owner admins and additive rule changes. 104 attack and feature tests.
- **Cloud:** a database per app, plain-English approval for anything that shows data to more people, the owner's data map, test logins through Basalt Auth and **Guard** (`basalt_check`). Guard scans the app folder for data kept outside Basalt, then signs in as two people and a stranger and tries 12 ways to reach data that isn't theirs, then writes a safety receipt for the owner. 49 tests.
- **Auth and hosting joined up:** Cloud apps use real Basalt Auth logins, and sessions Auth ends stop working in the database too. Every hosted environment gets its own Cloud data project, served at `/_basalt/data` on the app's own site. Claude sets its rules with `host_data_rules` (test environments go live right away, production waits for the owner's "Yes").
- Reviewed with Codex in several rounds. Every finding so far was fixed.

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

```sh
cd data && npm test        # needs Docker (starts its own Postgres)
cd cloud && npm test       # also runs Basalt Auth in-process
cd hosting && npm test
cd auth && npm test
cd api && npm test
```

## Still open

- Nothing has run on a real server with a domain and Cloudflare tunnel yet. The local demo setup above passes the full end-to-end run (47 checks) and a real-browser check.
- Hosted apps now use one connector. Cloud's standalone `basalt_*` connector remains for apps that aren't hosted on Basalt.
- The demo story: plain vibe coded apps vs Basalt apps. A first test found plain builds got basic per-customer checks right. The pitch is that nothing guarantees it, and later edits can quietly break it, while Basalt's rules sit below the code.
