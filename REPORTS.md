# Codepr-Monitor Reports

A running log of the work done on this project. Newest entries first.

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
