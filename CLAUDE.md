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
- Production database: PostgreSQL 16 (Docker Compose service `db`).
- Local database: SQLite, by setting `DATABASE_URL=sqlite:///./codepr_monitor.db`.
- Templating: Jinja2, server-rendered. No frontend build step and no CDN assets.
- Hosting: Docker Compose — `app`, `db`, and `uptime-kuma` services.
- Monitoring companion: Uptime Kuma (`louislam/uptime-kuma:1`) on port 3001.
- Odoo integration: JSON-RPC push into the `codepr.monitor.ticket` model provided
  by the bundled addon in `odoo-addon/codepr_monitor`.

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
