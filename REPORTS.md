# Codepr-Monitor Reports

A running log of the work done on this project. Newest entries first.

---

## 2026-08-11 — Moved the Docker stack back to PostgreSQL

### What changed

- Restored the `db` service in `docker-compose.yml` as `postgres:16-alpine`, on
  a new `monitor-pg-data` volume, and pointed the app's `DATABASE_URL` at it.
  Local runs without Docker deliberately stay on SQLite, so development still
  needs no database server.
- Gave `db` a `pg_isready` healthcheck and made `app` wait on
  `condition: service_healthy`. Without it a cold `docker compose up` races the
  database and the app fails its first connection.
- Wrote the password as `${POSTGRES_PASSWORD:?...}` in both services rather than
  giving it a default. Compose now refuses to start with a readable message
  instead of quietly creating a database with a password nobody chose, and no
  credential is written into a tracked file.
- Kept the old `monitor-sqlite-data` volume, mounted read-only on `app`. It is
  the only copy of the deployed accounts and tickets until the migration below
  has been run, and it is what that migration reads.
- Added `migrate_to_postgres.py`, a one-off copy of every row out of SQLite.
  Two things a plain row copy gets wrong are handled: naive SQLite datetimes are
  marked UTC before landing in `timestamptz`, which otherwise reads them in the
  server's timezone; and the id sequences are reset past the copied ids, which
  otherwise leaves the first new ticket trying to reuse id 1. It refuses to run
  against a non-empty target, since it is a move rather than a sync.
- Deleted `migrate_to_sqlite.py`. It existed to perform the move this entry
  reverses, so it has no remaining purpose; it stays in git history at `a3ac759`.
- Updated `README.md` (stack, the `POSTGRES_PASSWORD` setup step, a rewritten
  **The database** section covering `pg_dump` backup/restore and `psql` access, a
  migration section, and two new troubleshooting rows), `.env.example`,
  `CLAUDE.md`, `AGENTS.md`, and the now-inaccurate SQLite comments in the
  `Dockerfile`.
- No application code changed. `app/db.py` already branched on the URL, applying
  the SQLite pragmas only when the target is actually SQLite.

### Files touched

`docker-compose.yml`, `migrate_to_postgres.py` (new), `migrate_to_sqlite.py`
(deleted), `Dockerfile`, `.env.example`, `README.md`, `CLAUDE.md`, `AGENTS.md`.

### Verification

Run against a real `postgres:16-alpine` container, not by inspection:

- Built a SQLite database with the seeded sites and accounts plus a ticket, a
  screenshot, and a check row, then ran `migrate_to_postgres.py` against
  PostgreSQL. Verified row counts per table, that the ticket timestamp came back
  as the exact UTC instant it went in, that the attachment bytes were unchanged,
  that both foreign keys and the `user_sites` association still resolved, that
  the enum column round-tripped, and that a bcrypt hash copied across still
  verified its original password.
- Confirmed a new ticket inserted after the migration got an id past the copied
  ones, proving the sequence reset works, and that a second run of the script
  exits 1 with "Refusing to copy into a non-empty database".
- Ran the full 34-check application suite (below) a second time against
  PostgreSQL rather than SQLite. All 34 passed on both engines.
- `docker compose config` validates; with `POSTGRES_PASSWORD` unset it exits 1
  with `required variable POSTGRES_PASSWORD is missing a value: set
  POSTGRES_PASSWORD in .env`, which is the intended failure.
- The stack itself was not deployed, and the live SQLite data has not been
  migrated — that is the operator's step, documented in `README.md`.

---

## 2026-08-11 — Added admin role assignment, user editing, and impersonation

### What changed

- **Creating admins.** The create-user form already carried an `is_admin`
  checkbox; clarified what it grants, made the confirmation message say which
  role was created, and logged the creation of an administrator account.
- **Editing users.** Added `POST /admin/users/{id}`, so an admin can change an
  account's username, full name, email, role, and password. A blank password box
  means "leave it alone" — passwords are still write-only, so there is no way to
  read the old one back. Validation is shared with creation through a new
  `_account_error` helper rather than duplicated, and the uniqueness check
  excludes the account being edited so saving an unchanged username is not a
  clash with itself.
- **A lockout guard.** An admin cannot remove administrator access from the
  account they are signed in with. Since the acting user is always an admin, that
  alone guarantees an installation can never be left with no administrator.
- **Impersonation.** Added `POST /admin/users/{id}/impersonate`, which hands the
  session to another account, and `POST /impersonate/stop`, which returns it. The
  admin's id rides inside the signed session cookie, so the session genuinely
  *is* the other user: `get_current_user` returns the impersonated account and
  every existing permission check — `require_admin`, `can_access`,
  `visible_site_ids` — answers as it would for them, with no second code path to
  keep in sync.
- Put the exit route outside the admin area on purpose. An admin acting as a
  client is not an admin for that session, so a route behind `require_admin`
  would have stranded them with no way back.
- Made the session self-revoking: if the admin behind an impersonation is
  demoted or deleted while it is running, the whole session is rejected rather
  than left logged in as someone else. Nesting is collapsed too — impersonating
  from an impersonated session keeps the original admin as the way back, so the
  chain cannot be used to launder a session into a different admin.
- Added a persistent banner across every page while impersonation is active,
  fed by a Jinja context processor so it did not have to be threaded through
  each route's context. Both the start and the end are written to the log.

### Files touched

`app/security.py`, `app/templating.py`, `app/routers/auth.py`,
`app/routers/admin.py`, `app/templates/base.html`,
`app/templates/admin/users.html`, `app/static/app.css`, `README.md`,
`CLAUDE.md`, `AGENTS.md`.

### Verification

Exercised through the running app with `TestClient`, 34 checks, all passing on
both SQLite and PostgreSQL:

- Creating an admin, then signing in as that new account and reaching the admin
  dashboard and ticket queue — confirming the role is real, not just displayed.
- Editing a name and email; confirming a blank password left the stored hash
  byte-identical; changing the username and password together and signing in
  with the new credentials.
- Rejections: invalid username, duplicate username, short password on both
  create and edit, and self-demotion — with the acting admin's role confirmed
  unchanged in the database afterwards.
- Impersonating a client: redirected to the client landing page, the banner
  shown, client navigation instead of admin navigation, only that client's
  assigned page visible, and `/admin/users` answering 403 for the duration.
- Ending it: session restored to the admin, banner gone, admin area reachable
  again, and a second `/impersonate/stop` refused with 400.
- Abuse paths: a signed-in client cannot start an impersonation (403) or forge a
  stop (400); demoting the impersonating admin mid-session invalidates the
  session and redirects to `/login`.

One bug was found this way and fixed: the error page renders `base.html` with no
`user` in context, so a 403 raised *during* an impersonated session crashed the
banner with `'user' is undefined`. The banner now carries the same guard as the
navigation above it.

---

## 2026-08-11 — Moved the Docker stack from PostgreSQL to SQLite

### What changed

- Dropped the `db` service from `docker-compose.yml`. The stack is now `app` and
  `uptime-kuma`, with the database as one SQLite file on a new
  `monitor-sqlite-data` volume at `/srv/data/codepr_monitor.db`.
- Added the volume mount the app service never had. Without it the database file
  would sit in the container filesystem and be destroyed by the next
  `./update.sh` — the same trap that had already lost the HBPR URL change, but
  this time it would take every account and ticket with it.
- Created `/srv/data` in the image, owned by `appuser`. Docker seeds a fresh
  named volume from the image's directory, so without that the mount arrives
  root-owned and the app cannot create its database file.
- Set SQLite pragmas on every connection in `app/db.py`: WAL, so the 60-second
  check does not block readers; a 30-second `busy_timeout`, so a check and a
  ticket submission queue instead of raising "database is locked";
  `foreign_keys=ON`, which SQLite otherwise ignores and the attachment cascade
  depends on; and `synchronous=NORMAL`, which is still crash-safe under WAL.
  Also raised the driver-level lock timeout in `connect_args`.
- Added `migrate_to_sqlite.py`, a one-off copy of every row from PostgreSQL into
  a fresh SQLite file. Reseeding instead would have minted new password hashes
  and dropped the ticket history, so the accounts in `SECRETS.md` would have
  stopped working. It copies parents first and refuses to run against a
  non-empty target, since it is a move rather than a sync.
- Installed the `sqlite3` CLI in the image so the documented `.backup` command
  actually runs. `.backup` takes a consistent snapshot while the app is writing;
  `cp` on a live WAL database does not.
- Kept `psycopg` in `requirements.txt` and the old `monitor-db-data` volume on
  disk, so moving back to PostgreSQL is a `DATABASE_URL` change rather than a
  restore.
- Fixed a bug in `update.sh` that `--all` exposed: an empty service array was
  round-tripped through `printf`/`readarray`, which produced one empty string
  argument, so `docker compose build ""` failed with "no such service". The
  array is now expanded directly with `${SERVICES[@]+"${SERVICES[@]}"}`.
- Updated `README.md` with a **The database** section covering the file
  location, the pragmas, the backup procedure, and the way back to PostgreSQL.
  Corrected the stack line, the without-Docker section, and the now-wrong
  "Production database: PostgreSQL 16" lines in `CLAUDE.md` and `AGENTS.md`.

### Files touched

- New: `migrate_to_sqlite.py`
- Changed: `docker-compose.yml`, `Dockerfile`, `app/db.py`, `update.sh`,
  `README.md`, `CLAUDE.md`, `AGENTS.md`, `.env.example`

### Verification

- Counted the live PostgreSQL data first: 3 sites, 4 users, 3 grants, 1 ticket,
  1 attachment, 211 checks. Ran the migration inside the app image while the
  `db` service was still up, and every table matched on the other side.
- Confirmed the stack came up as two services with `journal_mode = wal` and the
  volume owned by `appuser`.
- Confirmed the migration preserved credentials rather than reseeding: the
  original `SEED_USER_PASSWORD` still signs in as user1, user2, and user3, and
  `SECRETS.md` gained no new block.
- Re-checked access control on the migrated data: `user1 → ['hbpr']`,
  `user2 → ['scholarship']`, `user3 → ['odoo']`; the migrated screenshot serves
  as `image/png` to its owner and to the admin, and 404s for another client.
- Load-tested the concurrency question directly, since it is the main reason not
  to pick SQLite: 20 parallel ticket submissions alongside a forced check-now
  returned 303 every time, with zero "database is locked" or `OperationalError`
  entries in the log. The 20 test tickets were then deleted, leaving the one real
  ticket.
- Ran the documented backup command end to end: `.backup` inside the container,
  `docker compose cp` out, then opened the copy and confirmed all six tables.
- Rebuilt once more afterwards and confirmed the data survived the rebuild,
  which is the behaviour the volume exists to provide.

---

## 2026-08-11 — Added screenshot attachments and per-user page access

### What changed

**Screenshots on tickets**

- Added a `TicketAttachment` model and a `screenshots` file input on the ticket
  form, with thumbnails on both the client's ticket list and the admin queue.
  Caps live in `.env`: `MAX_ATTACHMENTS_PER_TICKET` (3) and `MAX_ATTACHMENT_MB` (5).
- Stored the bytes in the database rather than on disk. The app container mounts
  no volume, so its filesystem does not survive a rebuild, while the Postgres
  volume does — the same trap that had already lost the HBPR URL change.
- Added `app/attachments.py`, which identifies the format from the file's
  leading bytes instead of trusting the browser's declared type, and rejects
  anything that is not PNG, JPEG, GIF, or WebP. SVG is excluded deliberately: it
  can carry script, so serving one back to an admin would be stored XSS.
  Filenames are reduced to a bare basename and are never used to touch disk.
- Served screenshots from an authenticated route, not from `/static`. A request
  succeeds only for the ticket's submitter or an admin, and anyone else gets a
  404 rather than a 403 so ids cannot be probed. Responses carry `nosniff` and
  a `default-src 'none'` CSP.

**Per-user page access**

- Added a `user_sites` association table. A client now sees only their assigned
  pages on the status view, in the `/api/status` poll behind it, and in the
  ticket form. `app/access.py` holds the rule in one place: admins are
  unrestricted, and a client with no assignment sees nothing, which is the safe
  direction to fail.
- Re-checked the rule when a ticket is submitted. The dropdown only offers
  permitted pages, but the id arrives in the request body, so the filtered
  dropdown is not treated as the boundary. A cross-page attempt answers 403.
- Added **Users** (`/admin/users`): admins create accounts, tick the pages each
  should hold, and change an existing account's pages. Passwords are hashed on
  save, never echoed back, and must be at least 10 characters.
- Seeded `user1` → HBPR, `user2` → Holberton Scholarship, `user3` → Odoo. Grants
  apply at account creation only; assignments are never rewritten on restart, so
  an admin's changes survive a rebuild.
- Gave the status page and ticket form real empty states, so an unassigned
  client is told to ask for access instead of seeing a bare page. The status
  banner no longer claims "All pages are online" when there are no pages.

**Also**

- Capitalised the nav and heading labels: **Page Status**, **My Tickets**,
  **Your Tickets**.

### Files touched

- New: `app/attachments.py`, `app/access.py`, `app/templates/admin/users.html`
- Changed: `app/models.py`, `app/config.py`, `app/seed.py`, `app/presenters.py`,
  `app/routers/client.py`, `app/routers/admin.py`, `app/routers/api.py`,
  `app/templates/base.html`, `app/templates/tickets.html`,
  `app/templates/status.html`, `app/templates/admin/tickets.html`,
  `app/static/app.css`, `README.md`

### Verification

- Wrote a 38-check end-to-end script against a throwaway SQLite database, all
  passing: seeded grants; a client seeing only their own page in `/api/status`
  and in the ticket form; a cross-page submission refused with 403; screenshots
  stored with the sniffed type and intact bytes; owner 200 / other client 404 /
  admin 200 on the attachment route; and rejection of a non-image, an oversized
  file, and more files than the cap. On the admin side: user creation with
  grants, a hashed password, access replaced and cleared, duplicate username and
  short password refused, and a non-admin blocked from both `/admin/users`
  routes with 403.
- Two failures found and fixed along the way, both in the no-screenshot path,
  which is the most common submission of all:
  - Widening the parameter to `list[UploadFile | str]` made pydantic resolve the
    union by coercing every real upload to a string, silently discarding all
    attachments. Reverted.
  - `isinstance(up, UploadFile)` is False for every real upload, because FastAPI
    passes Starlette's `UploadFile` rather than the FastAPI subclass this module
    imports. Replaced with a `getattr` on the filename.
  - A hand-built, browser-shaped request (an empty file part that still carries
    `filename=""`) confirmed the untouched-input case submits normally.
- Deployed with `./update.sh`. `create_all` added `user_sites` and
  `ticket_attachments` to the existing Postgres volume with no manual migration.
- Applied the three grants to the running database through the admin form, since
  seeding does not touch existing accounts. Confirmed live in Docker:
  `user1 → ['hbpr']`, `user2 → ['scholarship']`, `user3 → ['odoo']`, admin → all
  three; user1's ticket form offering only HBPR; a ticket against Odoo refused
  with 403; a non-admin getting 403 on `/admin/users`; a real PNG upload stored
  and served to its owner and to the admin but 404 to another client; and a
  `.png` containing SVG markup rejected with 400.

---

## 2026-08-11 — Closed the gap in the wordmark and made it white

### What changed

- Removed the `<span class="brand-thin">` wrapper in `app/templates/base.html`,
  so the header reads as the single text node `CodePR-Monitor`. The visible gap
  was not a margin or a space in the source: `.brand` is `display: inline-flex`
  with `gap: .55rem`, and a flex container wraps each contiguous run of text in
  its own anonymous item, so `CodePR` and the span were two items with the gap
  applied between them. The gap was only ever meant to sit between the status
  dot and the wordmark, which it now does.
- Added a `--brand-text` token and pointed `.brand` at it: `#ffffff` in dark
  mode, and the existing `#16202b` in light mode. Pure white in both themes
  would have put white text on the white `--surface` topbar, so only the dark
  palette — the one in use — is literally white.
- Dropped the now-unused `.brand-thin` rule. With the halves sharing a weight
  and a color, it had no remaining effect.

### Files touched

- `app/templates/base.html`, `app/static/app.css`

### Verification

- Rebuilt with `./update.sh`, which reported healthy.
- Fetched `/admin` from the container as `admin` and confirmed the served markup
  is `CodePR-Monitor` with no inner span, and that `/static/app.css` carries
  `--brand-text: #16202b`, the dark-mode `#ffffff`, and `color: var(--brand-text)`.
- No headless browser is installed on this machine, so the result was verified
  at the markup and stylesheet level rather than from a rendered screenshot.

### What changed

- Added `update.sh`: rebuilds the app image from the working tree, recreates the
  container, then polls `/healthz` until the app answers. It reads the published
  port from `docker compose port` instead of assuming 8090, so a changed port
  mapping cannot produce a false "unhealthy" result. On timeout it prints the
  last 40 log lines and exits non-zero.
- Supported `--all` for rebuilding every service, `--help`, and a usage error
  with exit code 2 for anything else. The script detects `docker compose` versus
  the older `docker-compose`, and refuses to run without a `.env`.
- Documented the update path in `README.md` under **Updating it after a code
  change**, including a table of what each kind of change requires. Recorded the
  reason the rebuild is needed at all: the Dockerfile copies `app/` in at build
  time and nothing is bind-mounted, so a running container serves the code it
  was built with and a plain `docker compose up` looks like a no-op.
- Wrote down two things that had caused confusion: pushing to GitHub does not
  touch any container, since the build reads files on disk regardless of commit
  state; and no rebuild changes data, because the Postgres volume survives and
  seeding only inserts pages that do not already exist.

### Files touched

- `update.sh` (new), `README.md`

### Verification

- Ran `bash -n update.sh`, plus `--help` and a bad-argument run, which printed
  the usage line and exited 2.
- End-to-end smoke test in both directions: appended a marker comment to
  `app/static/app.css`, ran `./update.sh`, and confirmed the container served
  the marker. Removed the marker, ran `./update.sh` again, and confirmed it was
  gone. The script reported healthy on both runs, and `app/static/app.css` was
  left byte-identical to its committed state.

### What changed

- Replaced the `https://github.com/adamb/hbpr` placeholder with the real HBPR
  site, `https://holbertonschoolpr.com/`, as the default `hbpr_url` in
  `app/config.py` and the `HBPR_URL` value in `.env.example`. `HBPR_URL` still
  overrides it, so a staging host can be watched without a code change.
- Updated the `.env` used for local runs to the same URL. It is gitignored, so
  this is a local-only change.
- Rewrote the README "hbpr target" section, which documented the private-repo
  caveat and the expected 404, and filled in the real URL in the monitored-pages
  table. Noted that the seed only inserts missing pages, so an existing
  deployment keeps the URL in its database until an admin edits it under
  **Pages**.
- Refreshed the now-stale comments in `app/config.py` and `app/seed.py`.

### Files touched

- `app/config.py`, `app/seed.py`, `.env.example`, `README.md`, `.env` (untracked)

### Verification

- Probed the URL directly: `https://holbertonschoolpr.com/` returns **200** with
  no redirect.
- Seeded a throwaway SQLite database with a scratch `SECRETS_FILE`, so the real
  `SECRETS.md` was untouched. The seeder logged
  `Seeded site hbpr -> https://holbertonschoolpr.com/` and the monitor's first
  pass logged `check hbpr -> up (HTTP 200)`.
- Re-pointed the existing local development database through the real admin form
  (`POST /admin/sites/1`) rather than by direct SQL, which exercised the
  history-clearing path. A forced re-check then moved hbpr from
  `down (HTTP 404)` to `up (HTTP 200)`.

---

## 2026-08-11 — Matched the "-Monitor" wordmark weight to "CodePR"

### What changed

- Removed `font-weight: 400` from `.brand-thin` in `app/static/app.css`, so
  `-Monitor` inherits the `.brand` weight of 700 and renders in the same face as
  `CodePR`. Both halves already shared the `--font` family; the weight was the
  only typographic difference. Kept `color: var(--muted)` so the second half
  still reads as secondary.

### Files touched

- `app/static/app.css`

### Verification

- Ran the app locally with `DATABASE_URL=sqlite:///./codepr_monitor.db` on port
  8077. Confirmed `/static/app.css` serves the updated `.brand-thin` rule and
  that the authenticated `/admin` topbar renders the
  `CodePR<span class="brand-thin">-Monitor</span>` markup the rule applies to.

---

## 2026-08-11 — Added a step-by-step run guide and settled where SECRETS.md lives

### What changed

- Rewrote the setup part of `README.md` as a numbered **How to run this app**
  guide: create `.env`, add a signing key, `docker compose up --build`, open the
  URLs, sign in. Included how to stop the stack, how to run without Docker, and a
  short troubleshooting table.
- Established `SECRETS.md` as a repository-root file, visible to the user and
  gitignored. Docker deliberately does not manage it: no bind mount, and nothing
  writes credentials into the container.
- Generated `.env` from `.env.example` with a random `SECRET_KEY`,
  `SEED_ADMIN_PASSWORD`, and `SEED_USER_PASSWORD`, then ran the app once to
  create `SECRETS.md` at the repository root. Because the seed passwords come
  from `.env`, the Docker stack creates the same four accounts with the same
  passwords, so the file stays accurate for either way of running the app.
- Implemented a non-root container user (`appuser`, uid 1000) so the application
  no longer runs as root.
- Documented in `.env.example` and `README.md` that the seed passwords must be
  set explicitly before starting the Docker stack: nothing writes credentials
  into the container, so blank values produce random passwords that cannot be
  read back, and the Postgres volume outliving a rebuild means seeding will not
  run again to replace them.

### Files touched

- `README.md`, `.env.example`, `Dockerfile`, `docker-compose.yml`, `REPORTS.md`
- Generated, untracked: `.env`, `SECRETS.md`

### Verification

- Confirmed the app boots clean with no errors, and that `SECRETS_FILE` is
  honoured when overridden and defaults to the repository root when not.
- Confirmed `SECRETS.md` was created at the repository root as
  `-rw------- Josh-linux Josh-linux`, listing all four seeded accounts.
- Confirmed `git check-ignore` matches `SECRETS.md` against `.gitignore:2` and
  `.env` against `.gitignore:3`, and that neither appears in `git status`.
- Confirmed the admin dashboard and `/healthz` still respond after the changes.
- Removed the earlier test-generated `SECRETS.md`, which belonged to a throwaway
  SQLite database.

Not verified: the Docker image build and Compose run, since Docker is still
unavailable in this WSL distro. The uid 1000 choice was checked against the host
account (`id -u` = 1000).

---

## 2026-08-11 — Initial build of CodePR-Monitor

### What changed

Implemented the first working version of CodePR-Monitor: a Dockerized FastAPI
application that checks web pages on an interval, shows clients a plain-language
status view, accepts tickets, gives admins a dashboard, embeds Uptime Kuma, and
mirrors tickets into Odoo.

**Infrastructure**

- Added a Docker Compose stack with three services: `app` (FastAPI on port 8090),
  `db` (PostgreSQL 16 with a healthcheck the app waits on), and `uptime-kuma`
  (`louislam/uptime-kuma:1` on port 3001).
- Added a Python 3.12 slim Dockerfile with a `/healthz` container healthcheck.
- Added `.gitignore` covering `SECRETS.md`, `.env`, virtualenvs, and local databases.

**Data layer**

- Added `User`, `Site`, `Check`, and `Ticket` models.
- Included a three-state `CheckStatus` (`up` / `degraded` / `down`) so a probe
  that never reaches the origin is never reported as healthy.
- Included Odoo bookkeeping fields on `Ticket` (`odoo_id`, `odoo_synced_at`,
  `odoo_error`) to make the mirror observable and retryable.

**Authentication**

- Implemented bcrypt password hashing and signed, `httponly`, `samesite=lax`
  session cookies via `itsdangerous`.
- Added `require_user` and `require_admin` dependencies guarding every route.
- Implemented first-boot seeding of four local accounts (`admin`, `user1`,
  `user2`, `user3`) and the three monitored pages.
- Implemented generation of `SECRETS.md` (gitignored, `chmod 600`) holding the
  seeded credentials, so plaintext passwords exist in exactly one untracked place.

**Monitoring**

- Implemented a background checker thread probing every active page on an
  interval, recording status, HTTP code, response time, and a detail string.
- Implemented Cloudflare Access detection: a redirect to `cloudflareaccess.com`,
  a `WWW-Authenticate: Cloudflare-Access` header, or an Access `Location` is
  classified `degraded` with an explanatory message, never `up`.
- Included optional `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers on
  probes for pages flagged as sitting behind Cloudflare Access.
- Added 24-hour uptime percentage, average response time, and history pruning.

**Client UI**

- Added a login page, a status page with per-page cards, a colour-and-text status
  pill, a sparkline of recent checks, and a summary banner.
- Added a ticket form capturing the page, ticket type (issue or fix request),
  subject, and details; the submission timestamp and submitter are attached
  automatically.
- Added a self-refreshing status view polling `/api/status` every 30 seconds.

**Admin UI**

- Added a dashboard with fleet counters, per-page cards, a run-checks-now action,
  and the latest tickets.
- Added a filterable ticket queue with inline status changes and an Odoo resync
  action.
- Added page management for adding, editing, deactivating, and re-pointing
  monitored pages.
- Added an Uptime Kuma embed at `/admin/kuma` with a direct-link fallback and
  guidance for pointing it at a status page if framing is refused.

**Odoo integration**

- Added the `codepr_monitor` Odoo 18 addon defining `codepr.monitor.ticket`, with
  list, form, and search views, mail threading, access rules, and a unique
  `monitor_ref` constraint.
- Implemented an outbound JSON-RPC push. JSON-RPC was chosen over XML-RPC because
  it allows the Cloudflare Access service-token headers to ride along on every
  request.
- Implemented the push as a background thread so a slow Odoo never delays a
  client's ticket submission, with failures recorded and retryable.

**Documentation**

- Added `CLAUDE.md` and `AGENTS.md` with project context, a security ruleset, the
  git workflow, and the reporting requirement.
- Added `README.md` covering setup, the Cloudflare Access caveat, the hbpr caveat,
  Odoo installation, and status classification.
- Added this `REPORTS.md`.

### Findings that shaped the design

- `https://odoo.code.pr` sits behind Cloudflare Zero Trust. An unauthenticated
  request is redirected to `fincadelmar.cloudflareaccess.com`, which answers
  `200` — a naive checker would report Odoo as healthy while never reaching it.
  This drove the three-state status model and the service-token support.
- `https://github.com/adamb/hbpr/` returns 404 unauthenticated, so the repository
  is private and its deployed URL is not discoverable. A repository is also not a
  monitorable target. The entry is configurable via `HBPR_URL` and editable in the
  admin UI; until it is set, the page correctly reports Offline (HTTP 404).
- `https://scholarship.holbertonschoolpr.com/` returns 200 and needs no special
  handling.

### Files touched

- `Dockerfile`, `docker-compose.yml`, `requirements.txt`, `.env.example`, `.gitignore`
- `app/__init__.py`, `app/main.py`, `app/config.py`, `app/db.py`, `app/models.py`
- `app/security.py`, `app/seed.py`, `app/monitor.py`, `app/odoo.py`
- `app/presenters.py`, `app/templating.py`
- `app/routers/__init__.py`, `app/routers/auth.py`, `app/routers/client.py`,
  `app/routers/admin.py`, `app/routers/api.py`
- `app/static/app.css`
- `app/templates/base.html`, `login.html`, `status.html`, `tickets.html`,
  `error.html`, `_site_card.html`
- `app/templates/admin/dashboard.html`, `tickets.html`, `sites.html`, `kuma.html`
- `odoo-addon/codepr_monitor/__init__.py`, `__manifest__.py`,
  `models/__init__.py`, `models/codepr_monitor_ticket.py`,
  `security/ir.model.access.csv`, `views/codepr_monitor_ticket_views.xml`
- `README.md`, `CLAUDE.md`, `AGENTS.md`, `REPORTS.md`

### Verification

Docker is not available in this WSL distro, so the stack was verified by running
the application directly against SQLite in a local virtualenv, on a throwaway
database outside the repository.

Verified working:

- Dependency install from `requirements.txt` on Python 3.12.
- Application boot: schema creation, page and account seeding, `SECRETS.md`
  generation, monitor thread start.
- Live checks against all three real targets:
  - `scholarship.holbertonschoolpr.com` → **up** (HTTP 200)
  - `odoo.code.pr` → **degraded** ("Blocked by Cloudflare Access — no service
    token configured"), confirming the redirect is not mistaken for health
  - `github.com/adamb/hbpr` → **down** (HTTP 404), the expected placeholder result
- Anonymous access to `/`, `/status`, and `/admin` redirects to `/login`;
  `/api/status` returns `401 {"detail":"Authentication required."}`.
- Login: wrong password returns 401; `user1` lands on `/status`; `admin` lands on
  `/admin`.
- Authorization: a client session requesting `/admin` receives 403.
- Admin pages `/admin`, `/admin/tickets`, `/admin/sites`, `/admin/kuma` all return 200.
- Ticket submission stores and renders the subject, page, type, submitter name,
  and submission timestamp; the ticket appears in the client list and the admin
  queue with the submitter's full name.
- Form validation returns the friendly inline errors for a blank subject and for
  no page selected.
- Admin actions: adding a page, editing a page, changing ticket status, and
  running all checks on demand.

Not verified: the Docker image build and Compose stack (no Docker available), the
Uptime Kuma embed, and the Odoo push against a live Odoo — the latter needs a
Cloudflare Access service token and Odoo credentials that do not exist yet.

### Fixes made during verification

- Fixed `/api/status` returning `{"detail":"See Other"}` to unauthenticated
  callers; it now returns `Authentication required.` with a 401.
- Fixed the ticket form answering with a raw 422 JSON body when a field was left
  empty. FastAPI reports an empty form value as missing, so the fields now default
  to `""` and the handler owns validation, producing the friendly inline error.
- Fixed stale status being shown after an admin changes a page's URL. The check
  history described the previous target, so it is now cleared on a URL change.
