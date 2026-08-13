# Codepr-Monitor Claude Context

## Project Purpose

Codepr-Monitor is a Dockerized web application that tracks whether CodePR's web
properties are online, and lets clients raise tickets about them.

The project is intended to help manage:

- Automated uptime checks against a configurable list of web pages.
- A friendly client view showing, in plain language, whether a page is up.
- Client ticket submission, capturing the submission date and time, the user's
  name, and the page the ticket is for.
- An admin dashboard covering every monitored page and the full ticket queue.
- An embedded Uptime Kuma instance for deeper history and alerting.
- Mirroring of tickets into Odoo, where CodePR support work already lives.

The initial monitoring targets are the hbpr project site, the Holberton PR
scholarship portal, and the Odoo instance at odoo.code.pr.

## Technical Context

- Framework: FastAPI.
- Language: Python 3.12.
- Database layer: SQLAlchemy 2.x ORM.
- Database: PostgreSQL 16 in Docker, as the `db` service on the
  `monitor-pg-data` volume; the app reaches it over `DATABASE_URL` and waits on
  the service healthcheck before starting. Local runs without Docker stay on
  SQLite in WAL mode — set `DATABASE_URL=sqlite:///./codepr_monitor.db`.
- Nothing in the app is engine-specific. `DATABASE_URL` alone decides which
  engine is in use, and `app/db.py` applies the SQLite pragmas only when it is
  actually SQLite.
- Templating: Jinja2, server-rendered. No frontend build step and no CDN assets.
- Hosting: Docker Compose — `db`, `app`, and `uptime-kuma` services.
- Monitoring companion: Uptime Kuma (`louislam/uptime-kuma:1`) on port 3001.
- Odoo integration: JSON-RPC push into the `codepr.monitor.ticket` model provided
  by the bundled addon in `odoo-addon/codepr_monitor`.

### Second deployment: Cloudflare Workers (`worker/`)

The same app also runs as the `cpr-monitor` Worker, deployed from GitHub. It is
a **rewrite, not a port**, and an independent deployment with its own database —
nothing is shared with the Docker stack, including accounts.

- Stack: Hono, Hono JSX, D1 (SQLite), R2, Cron Triggers, Workers Assets.
- The Workers runtime has no filesystem, no threads, and no raw TCP sockets, so
  bcrypt, psycopg, the monitor thread, and the Uptime Kuma container all had to
  be replaced. `worker/README.md` has the table of what became what.
- Passwords there are PBKDF2-HMAC-SHA256 on Web Crypto, not bcrypt. **The two
  deployments' password hashes are not interchangeable in either direction.**
- Uptime Kuma cannot run on Workers. It has to be hosted separately, with
  `UPTIME_KUMA_EMBED_URL` pointed at it.
- Seeding runs locally via `worker/scripts/seed.ts`, not on first boot.
- Every security rule below applies there too, and is implemented there.
- Work on one deployment does not implicitly apply to the other. A change to
  behaviour that should hold everywhere has to be made in both `app/` and
  `worker/src/`.

### Layout

- `app/main.py` — app factory, lifespan (schema, seeding, monitor thread), error handling.
- `app/config.py` — all settings, read from the environment.
- `app/models.py` — `User`, `Site`, `Check`, `Ticket`.
- `app/monitor.py` — the background checker and the uptime read helpers.
- `app/odoo.py` — outbound ticket mirroring.
- `app/security.py` — password hashing, signed session cookies, auth dependencies.
- `app/seed.py` — first-boot sites and accounts, writes `SECRETS.md`.
- `app/routers/` — `auth`, `client`, `admin`, `api`.
- `app/templates/`, `app/static/` — server-rendered UI.

## Security Rules for Claude

Treat these as hard requirements; this app holds client credentials and reaches
into Odoo.

- Never commit `SECRETS.md` or `.env`. Both are gitignored — keep them that way.
- Never write a real password, service token, or API key into a tracked file,
  including this one, `README.md`, `REPORTS.md`, and example configs.
- Passwords are hashed with bcrypt. Never store, log, or render a plaintext
  password anywhere except the generated `SECRETS.md`.
- `SECRET_KEY` signs session cookies. It must be overridden in production; the
  built-in default is explicitly labelled insecure and is for local runs only.
- Session cookies stay `httponly` and `samesite=lax`. Add `secure=True` when the
  app is served over HTTPS.
- Keep the login error message identical for unknown users and wrong passwords,
  so the form does not reveal which usernames exist.
- Every admin route depends on `require_admin`. Never expose site management,
  the ticket queue, or the Kuma embed to a non-admin session.
- Impersonation is admin-only. The admin behind an impersonated session lives in
  the signed session cookie and nowhere else — never accept it from a form field
  or query string, and never let the session outlive that admin's own access.
- `/impersonate/stop` must stay outside `require_admin`. An admin acting as a
  client is not an admin for that session, so putting the way out inside the
  admin area would strand them.
- Permission checks measure the impersonated user, never the admin behind them.
  `get_current_user` returns the effective user for exactly that reason.
- Never let a Cloudflare Access login redirect be reported as "up". A probe that
  does not reach the origin is `DEGRADED`, never `UP` — this is the difference
  between a monitor that works and one that lies.
- Cloudflare Access service tokens and Odoo credentials come from the
  environment only. Never hardcode them, and never render them in a template.
- Odoo pushes are best-effort and must never block or fail a client's ticket
  submission. Keep the mirror idempotent via `monitor_ref`.
- Escape anything client-supplied that is rendered. Jinja2 autoescaping is on by
  default — do not disable it or introduce `|safe` on ticket text.

## Working Rules for Claude

- Never commit anything to GitHub or create git commits automatically.
- Never run `git commit`, `git push`, or any command that publishes changes
  unless the user explicitly asks for that exact command to be run.
- After making changes, always give the user the manual `git add` command and a
  suggested `git commit` command for them to run themselves.
- Use past tense verbs like Added, Implemented, and Included.
- Keep changes focused on the requested task and avoid unrelated refactors.
- Preserve any user changes already present in the working tree.
- Prefer the existing project patterns and components before introducing new
  abstractions.
- Verify changes by actually running the app, not by inspection alone. A venv
  plus `DATABASE_URL=sqlite:///...` is enough to exercise every route.

## Reporting Requirement

Every implementation must be documented in `REPORTS.md`.

For each report entry:

- Use the date the work was done.
- Briefly describe what changed.
- Mention the files touched.
- Include any verification performed, such as type checks, lint, tests, or why
  verification was not run.

Append new entries to the top of `REPORTS.md` so the newest work is easiest to find.

@AGENTS.md
