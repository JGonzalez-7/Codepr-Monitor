# CodePR-Monitor on Cloudflare Workers

The `cpr-monitor` Worker: the same app as the Python one in `../app`, rebuilt on
the Workers runtime. Deploys from GitHub.

The Python app is still in this repo and still runs under Docker Compose. This
is a **separate deployment with its own database** — nothing is shared between
them, including accounts.

## Why it is a rewrite and not a port

Workers has no filesystem, no threads, and no raw TCP sockets, which rules out
four things the Python app is built on:

| Python | Here | Consequence |
| --- | --- | --- |
| `bcrypt` | PBKDF2-HMAC-SHA256 via Web Crypto | **Existing password hashes cannot be carried over.** Every account is re-seeded. |
| `psycopg` → PostgreSQL | D1 (SQLite) over a binding | Schema is in `migrations/`, not SQLAlchemy models. |
| screenshots in a `BYTEA` column | R2, key in the D1 row | Reads still go through the same authenticated route. |
| `threading` monitor loop | Cron Trigger, once a minute | Cadence is set by `triggers.crons`, not by `CHECK_INTERVAL_SECONDS`. |
| Jinja2 | Hono JSX | Autoescaping still on by default. |
| Uptime Kuma container | — | **Cannot run on Workers at all.** Host it elsewhere and point `UPTIME_KUMA_EMBED_URL` at it. |

Everything else behaves as before: the same routes, the same access rules, the
same wording, the same `app.css`.

## Stack

Hono · Hono JSX · D1 · R2 · Cron Triggers · Workers Assets

## First deploy

### 1. Create the database and the bucket

```bash
cd worker
npm install
npx wrangler login

npx wrangler d1 create cpr-monitor
npx wrangler r2 bucket create cpr-monitor-screenshots
```

`d1 create` prints a `database_id`. Put it in `wrangler.jsonc`, replacing
`REPLACE_WITH_D1_DATABASE_ID`. That file is committed — the id is not a secret.

### 2. Create the schema

```bash
npm run migrate:remote
```

### 3. Set the secrets

These never go in `wrangler.jsonc`.

```bash
# Signs session cookies. Without it the Worker refuses to start a session.
node -e "console.log(crypto.randomUUID().replace(/-/g,'')+crypto.randomUUID().replace(/-/g,''))" \
  | npx wrangler secret put SECRET_KEY

# Only if you are mirroring tickets into Odoo:
npx wrangler secret put ODOO_DB
npx wrangler secret put ODOO_USERNAME
npx wrangler secret put ODOO_PASSWORD

# Only if you have a Cloudflare Access service token for odoo.code.pr:
npx wrangler secret put CF_ACCESS_CLIENT_ID
npx wrangler secret put CF_ACCESS_CLIENT_SECRET
```

### 4. Seed the accounts

There is no first-boot seeding — a Worker has no startup hook that could hold a
credential. Seeding runs on your machine instead:

```bash
SEED_ADMIN_PASSWORD='...' SEED_USER_PASSWORD='...' npm run seed
npx wrangler d1 execute cpr-monitor --remote --file=seed.generated.sql
rm seed.generated.sql
```

This creates `admin`, `user1`, `user2`, `user3` and the three monitored pages,
writes the passwords to `SECRETS.md` (gitignored), and hashes them with the same
code the Worker verifies them with. Leaving the `SEED_*` variables unset
generates random passwords — they will be in `SECRETS.md`, which is the only
place they exist.

Both `seed.generated.sql` and `SECRETS.md` are gitignored. Delete the SQL once
applied; the hashes are in D1 by then.

### 5. Deploy

```bash
npm run deploy
```

## Connecting it to GitHub

Once the first manual deploy has run, hand deploys over to Workers Builds:

1. **Workers & Pages → cpr-monitor → Settings → Build**.
2. **Connect** the `JGonzalez-7/CodePR-Monitor` repository.
3. Set:

   | Field | Value |
   | --- | --- |
   | Root directory | `worker` |
   | Build command | `npm ci` |
   | Deploy command | `npx wrangler deploy` |
   | Branch | `main` |

`worker` as the root directory is the important one — the repository root is the
Python app, which has no `package.json`.

Every push to `main` then builds and deploys. The D1 and R2 bindings and the
cron trigger come from `wrangler.jsonc`; secrets stay in the dashboard and are
not touched by a build.

## Running it locally

```bash
cp .dev.vars.example .dev.vars    # set SECRET_KEY to anything for local use
npm run migrate:local
SEED_ADMIN_PASSWORD='localadmin123' SEED_USER_PASSWORD='localuser123' npm run seed -- --local
npx wrangler d1 execute cpr-monitor --local --file=seed.generated.sql
npm run dev
```

Then open http://localhost:8787. This is a local SQLite file under `.wrangler/`
with its own accounts — nothing here touches the deployed data.

To fire a monitor round without waiting for the cron:

```bash
curl http://localhost:8787/cdn-cgi/handler/scheduled
```

## Things to know before you rely on it

**Password hashing costs CPU on every login.** `PBKDF2_ITERATIONS` is 100,000 by
default. The Workers **Free** plan allows 10 ms of CPU per request, which that
will exceed — logins will fail with an exceeded-CPU error. Either run on the
Workers Paid plan ($5/mo, 30 s limit), or lower the value. Lowering it weakens
the hash against offline cracking, so prefer the paid plan. The iteration count
is stored inside each hash, so changing it does not invalidate existing accounts
— they keep verifying at the cost they were created with, and re-hash to the new
cost the next time their password is set.

**The cron runs every minute, which is the floor.** Cron Triggers cannot go
below one minute. `CHECK_INTERVAL_SECONDS` only labels the dashboard; to change
the real cadence, edit `triggers.crons` in `wrangler.jsonc`.

**Ticket lists are capped at 500 rows.** D1 bills row reads, and the Python
version listed every ticket unbounded. When the cap is hit the page says so.

**24h uptime comes from a rollup, not a live scan.** `site_stats` is recomputed
by the cron after each round, so the figure is at most one minute stale. The
Python app aggregated the raw history on every render, which on D1 would spend
the daily read allowance on the status page's own 30-second poll.

**Uptime Kuma is not here.** `/admin/kuma` still embeds whatever
`UPTIME_KUMA_EMBED_URL` points at, but you have to run Kuma somewhere that can
host a long-running container.

## Layout

| Path | What |
| --- | --- |
| `src/index.tsx` | Worker entry: `fetch` + `scheduled`, error handling |
| `src/config.ts` | Settings, read per request from `env` |
| `src/types.ts` | Bindings, row shapes, domain enums |
| `src/db.ts` | Every D1 query |
| `src/password.ts` | PBKDF2 hashing — shared with the seed script |
| `src/security.ts` | Signed session cookies, auth middleware, impersonation |
| `src/access.ts` | Which pages a user may see |
| `src/monitor.ts` | Probing and classification |
| `src/odoo.ts` | Outbound ticket mirroring |
| `src/attachments.ts` | Upload sniffing and size limits |
| `src/presenters.ts`, `src/format.ts` | View models and display helpers |
| `src/routes/` | `auth`, `client`, `admin`, `api` |
| `src/views/` | Hono JSX, one file per former template |
| `public/static/app.css` | Unchanged from the Python app |
| `migrations/` | D1 schema |
| `scripts/seed.ts` | Local seeding |
