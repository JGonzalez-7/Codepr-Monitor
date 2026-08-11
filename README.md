# CodePR-Monitor

Uptime tracking for CodePR web properties, with a friendly client view, an admin
dashboard, an embedded Uptime Kuma, and ticket mirroring into Odoo.

- **Clients** sign in, see at a glance whether their pages are online, and submit
  a ticket for a problem or a requested fix. Every ticket records the submission
  date and time, the submitter's name, and the page it is for.
- **Admins** get a dashboard of every monitored page, the full ticket queue, page
  management, and Uptime Kuma embedded for deeper history and alerting.

## Stack

FastAPI · Jinja2 · SQLAlchemy · PostgreSQL 16 · Uptime Kuma · Docker Compose

## How to run this app

### Step 1 — Create your settings file

```bash
cp .env.example .env
```

### Step 2 — Add a signing key

Generate a random key:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

Open `.env` and paste the result after `SECRET_KEY=`. Without this, login
sessions can be forged.

### Step 3 — Start it

```bash
docker compose up --build
```

Wait for `Application startup complete` in the output.

### Step 4 — Open it

| What | Where |
| --- | --- |
| CodePR-Monitor | http://localhost:8090 |
| Uptime Kuma | http://localhost:3001 |

### Step 5 — Sign in

The app creates four accounts: `admin`, plus `user1`, `user2`, and `user3`.
Their passwords are the `SEED_ADMIN_PASSWORD` and `SEED_USER_PASSWORD` values
from your `.env`, and they are also listed in **`SECRETS.md`** in this folder.

Sign in as `admin` for the dashboard, or as `user1` for the client view. Each
seeded client starts with one page: `user1` → HBPR, `user2` → Holberton
Scholarship, `user3` → Odoo. See [Who sees what](#who-sees-what).

> **Set the seed passwords in `.env` before you start the stack.** Nothing
> writes credentials into the container, so if you leave them blank, Docker
> generates random passwords you cannot read back — and because the database
> volume survives a rebuild, seeding will not run again to replace them.

### Updating the container after a code change

```bash
./update.sh
```

That rebuilds the image, recreates the container, and waits for it to report
healthy. Use `./update.sh --all` when `docker-compose.yml` itself changed.

### Stopping it

```bash
docker compose down            # stop
docker compose down -v         # stop and erase all data, including accounts
```

---

### Running it without Docker

Docker Desktop's WSL integration is not always enabled on this machine. The app
also runs directly against SQLite, which is handy for development:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

DATABASE_URL="sqlite:///./codepr_monitor.db" \
SECRET_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')" \
.venv/bin/uvicorn app.main:app --reload --port 8090
```

Then open http://localhost:8090. A local run writes `SECRETS.md` to this folder
listing the seeded accounts.

This starts the app only — Uptime Kuma and PostgreSQL are not included, so the
`/admin/kuma` page will be empty.

### If something goes wrong

| Problem | Fix |
| --- | --- |
| `port is already allocated` | Something else uses 8090 or 3001. Change the left-hand number in `docker-compose.yml` under `ports`. |
| Forgot the passwords | They are in `SECRETS.md` and in `.env`. If both are gone, set new `SEED_*` values in `.env` and run `docker compose down -v`, then start again — this erases all data, including tickets. |
| Every page shows "Offline" | The app has no internet access from inside the container. |

## Monitored pages

| Page | URL | Notes |
| --- | --- | --- |
| HBPR | https://holbertonschoolpr.com/ | Returns 200; override with `HBPR_URL` |
| Holberton Scholarship | https://scholarship.holbertonschoolpr.com/ | Returns 200 |
| Odoo — code.pr | https://odoo.code.pr | Behind Cloudflare Access |

Admins can add, edit, deactivate, and re-point pages under **Pages**
(`/admin/sites`) — the seed list is only a starting point. Changing a page's URL
clears its check history, so the displayed status always reflects the URL
actually being checked.

## Who sees what

A client sees only the pages assigned to their account. That covers the status
view, the `/api/status` poll behind it, the pages offered in the ticket form,
and which page a ticket may be filed against. An admin is unrestricted.

| Account | Pages |
| --- | --- |
| `admin` | Every page, plus Pages, Users, and the ticket queue |
| `user1` | HBPR |
| `user2` | Holberton Scholarship |
| `user3` | Odoo — code.pr |

Manage this under **Users** (`/admin/users`), where an admin can create an
account and tick the pages it should hold, or change an existing account's
pages. A client with no pages assigned sees an empty state explaining that,
rather than an empty dashboard — access defaults to nothing, not everything.

The ticket form only offers pages the client holds, and the same rule is
re-checked when the form is submitted, since the page id travels in the request
body and a dropdown is not a security boundary.

Those grants apply when an account is **created**. Assignments are never
rewritten on restart, so an existing deployment keeps whatever an admin last
set under Users.

### Screenshots on tickets

Clients can attach up to `MAX_ATTACHMENTS_PER_TICKET` images (default 3) of at
most `MAX_ATTACHMENT_MB` each (default 5) to a ticket. They appear as thumbnails
on the client's own ticket list and on the admin queue.

The bytes are stored in the database, not on disk: the app container mounts no
volume, so its filesystem does not survive a rebuild, while the Postgres volume
does. It also means every screenshot is served by an authenticated route that
checks the requester is the submitter or an admin, instead of sitting at a
guessable static URL.

The accepted formats — PNG, JPEG, GIF, WebP — are identified from the file's
leading bytes rather than from the type the browser claims. SVG is refused on
purpose: it can carry script, so serving one back to an admin would be a stored
XSS vector.

### The HBPR target

The HBPR page monitors `https://holbertonschoolpr.com/`, which answers `200` and
needs no special handling. This replaces the earlier placeholder that pointed at
the private `github.com/adamb/hbpr` repository — a source repository was never a
monitorable target; what matters is the site it deploys to.

`HBPR_URL` in `.env` still overrides the URL, so a staging host can be watched
instead without a code change. Because the seed only inserts missing pages, an
existing deployment keeps the URL already in its database: change it under
**Pages** (`/admin/sites`), which also clears the stale check history.

### Cloudflare Access and odoo.code.pr

`odoo.code.pr` sits behind Cloudflare Zero Trust (`fincadelmar.cloudflareaccess.com`).
An unauthenticated probe is redirected to the Access login page, which answers
`200` — so a naive checker would report Odoo as healthy while never reaching it.

CodePR-Monitor detects that redirect and reports **Needs attention** with
`Blocked by Cloudflare Access`, never **Online**.

To monitor Odoo for real, and to enable ticket mirroring:

1. In Cloudflare Zero Trust, go to **Access → Service Auth** and create a service
   token.
2. Add a policy on the `odoo.code.pr` application that includes that token
   (an *Include → Service Auth* rule).
3. Put the credentials in `.env`:

   ```
   CF_ACCESS_CLIENT_ID=<id>.access
   CF_ACCESS_CLIENT_SECRET=<secret>
   ```

The token is sent on probes for any page flagged *Behind Cloudflare Access*, and
on every Odoo JSON-RPC call.

## Odoo integration

Odoo is a downstream sink: CodePR-Monitor owns the ticket, and each submission is
mirrored into the `codepr.monitor.ticket` model.

Install the addon:

```bash
cp -r odoo-addon/codepr_monitor ../Odoo18-LOCAL/addons/
# Odoo → Apps → Update Apps List → install "CodePR Monitor Tickets"
```

Then enable the push in `.env`:

```
ODOO_ENABLED=true
ODOO_URL=https://odoo.code.pr
ODOO_DB=<database name>
ODOO_USERNAME=<integration user>
ODOO_PASSWORD=<password or API key>
```

The push runs in a background thread, so a slow or unreachable Odoo never delays
a client's submission. Failures are recorded on the ticket and retryable from the
admin ticket queue. The mirror is idempotent: it looks up `monitor_ref` before
creating, so retries adopt the existing record instead of duplicating it.

Use a dedicated Odoo user with access only to this model, not an administrator.

## Uptime Kuma

Kuma runs as its own container with its own accounts. On first run, open
http://localhost:3001, create the admin user, and add monitors for the pages you
care about.

The admin UI embeds it at `/admin/kuma`. If the frame stays blank, Kuma is
refusing to be framed — publish a status page in Kuma and point
`UPTIME_KUMA_EMBED_URL` at it (for example `http://localhost:3001/status/codepr`),
which is the surface designed for embedding. A direct link is always shown as a
fallback.

## How checks are classified

| Status | Meaning |
| --- | --- |
| **Online** | `2xx` response from the page. |
| **Needs attention** | Reached the server but could not confirm health — a Cloudflare Access wall, or an unresolved redirect. |
| **Offline** | `4xx`/`5xx`, connection failure, or timeout. |

Checks run every `CHECK_INTERVAL_SECONDS` (default 60) in a background thread.
History is pruned after `HISTORY_RETENTION_DAYS` (default 30). The client status
page refreshes itself every 30 seconds via `/api/status`.

## Project docs

- `CLAUDE.md` / `AGENTS.md` — working context, security rules, and git workflow.
- `REPORTS.md` — running log of every change made to the project.
