# Basalt Cloud

Hosts a locked down database for every app built with Claude Code, plus the MCP server Claude Code uses to set one up. The person building never sets anything up or reads anything technical. Claude asks them plain questions, and anything that shows data to more people waits for them to tap "Yes" on an approval page.

Each app gets its own Postgres database and its own three roles, built by the [Data block](../data/README.md). Each app's database password and signing secret are stored encrypted (AES-256-GCM).

## MCP tools

This standalone connector is for apps that keep their data in Basalt Cloud but aren't hosted on Basalt. Apps hosted on Basalt Host use the single Basalt Host connector (`@basalt/host-mcp`), which covers the same ground per environment: `host_data_rules`, `host_data_status`, `host_data_admin`, `host_data_check` (Guard, with the same local code scan) and `host_guide { topic: "data" }`.

| Tool | What it does |
| --- | --- |
| `basalt_start` | Makes the app's database and saves its key in `.basalt/` (kept out of git) |
| `basalt_set_rules` | Sets what the app saves and who can see it. Looser rules need the owner's approval |
| `basalt_status` | Live or waiting, the rules in plain English and the owner's data map link |
| `basalt_connect_app` | The `basalt.js` file the app uses for every read, save and upload |
| `basalt_make_admin` | Asks the owner to let one person see everything |
| `basalt_test_login` | A login token for a pretend person, for trying the app |
| `basalt_check` | Guard: the safety check and receipt (below) |

Add it to Claude Code:

```sh
claude mcp add basalt -e BASALT_URL=<basalt cloud url> -- node <path to repo>/cloud/src/mcp.ts
```

## Guard

`basalt_check` runs before an app goes live and again after changes to how it saves data.

1. **Code scan** (on the builder's machine): looks through the app folder for data kept outside Basalt. That covers browser storage, other data services (Firebase, Supabase, MongoDB, SQLite, Prisma, Vercel KV and more), data written to files, database files and a Basalt key pasted into code or a `.basalt/` folder git would pick up. Auth and API code mistakes are covered by `auth_review_code` and `api_review_code`, so they aren't repeated.
2. **Live checks** (on the server): signs in to the app's own data API as two pretend people and a stranger. It tries 11 things (12 when the app takes uploads): no login, a made up login, a forged login, an expired login, and opening, listing, changing and removing someone else's entry. It also tries saving an entry in someone else's name, reading the database's own tables, a search that tries to sneak in database code and, if the app takes uploads, downloading someone else's file. The test entries are archived afterwards.
3. **Safety receipt**: a page for the owner at `/owner/<app>/check?k=<key>` that lists every check in plain words, plus what the code scan found.

A test runs the same checks against a deliberately leaky server and confirms they fail, so a leak is never reported as safe.

## Run it

Needs the Data block's local Postgres (`cd ../data && npm run db:up`).

```sh
cp .env.example .env   # fill in the values it describes
npm start              # http://127.0.0.1:8790
npm test               # end to end tests against real Postgres
```

No npm dependencies. It reuses the Data block's `pg` driver.
