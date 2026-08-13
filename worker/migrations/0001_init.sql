-- CodePR-Monitor schema, ported from the SQLAlchemy models in app/models.py.
--
-- Timestamps are ISO-8601 UTC strings ('2026-08-13T14:03:11.482Z'). That format
-- sorts and compares lexicographically, so ORDER BY and the retention cutoff in
-- src/monitor.ts work as plain string comparisons — no date functions needed.
-- Booleans are INTEGER 0/1, which is what D1 returns for them.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  full_name     TEXT    NOT NULL,
  email         TEXT    NOT NULL DEFAULT '',
  password_hash TEXT    NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);

CREATE TABLE sites (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT    NOT NULL UNIQUE,
  name           TEXT    NOT NULL,
  url            TEXT    NOT NULL,
  description    TEXT    NOT NULL DEFAULT '',
  is_active      INTEGER NOT NULL DEFAULT 1,
  -- Send the Cloudflare Access service token with this site's probes.
  uses_cf_access INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL
);

-- Which pages a client may see and raise tickets about. Admins are not listed
-- here; they are unrestricted by rule, so an empty row set for an admin never
-- means "no access".
CREATE TABLE user_sites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, site_id)
);

CREATE TABLE checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  checked_at  TEXT    NOT NULL,
  -- 'up' | 'degraded' | 'down'. DEGRADED covers "reachable, but the response
  -- does not prove the app is healthy" — most importantly a Cloudflare Access
  -- login redirect, which would otherwise look like a healthy 200.
  status      TEXT    NOT NULL,
  http_status INTEGER,
  response_ms REAL,
  detail      TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE tickets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id        INTEGER NOT NULL REFERENCES sites(id),
  user_id        INTEGER NOT NULL REFERENCES users(id),
  subject        TEXT    NOT NULL,
  body           TEXT    NOT NULL DEFAULT '',
  kind           TEXT    NOT NULL DEFAULT 'issue',   -- 'issue' | 'fix'
  status         TEXT    NOT NULL DEFAULT 'open',    -- 'open' | 'in_progress' | 'resolved'
  -- Submission timestamp shown to clients and mirrored into Odoo.
  submitted_at   TEXT    NOT NULL,
  -- Odoo mirror bookkeeping.
  odoo_id        INTEGER,
  odoo_synced_at TEXT,
  odoo_error     TEXT    NOT NULL DEFAULT ''
);

-- A screenshot attached to a ticket. The bytes live in R2 under `r2_key`, not
-- in this row: D1 caps a row well below the 5 MB an attachment may reach. The
-- key is random and never exposed, so reads still go through the authenticated
-- route in src/routes/client.tsx rather than a guessable URL.
CREATE TABLE ticket_attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id    INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  -- Display label only; never used to build the R2 key.
  filename     TEXT    NOT NULL,
  -- Sniffed from the file's leading bytes, not taken from the browser.
  content_type TEXT    NOT NULL,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  r2_key       TEXT    NOT NULL,
  uploaded_at  TEXT    NOT NULL
);

-- 24-hour rollup, recomputed by the cron after each round of probes.
--
-- The Python app derived these with COUNT/AVG over the check history on every
-- page load. That is ~1,440 rows per site per render, and the status page polls
-- itself every 30s — enough to burn through D1's daily row-read allowance on
-- its own. Storing one row per site turns each render into a single read.
CREATE TABLE site_stats (
  site_id     INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  uptime_24h  REAL,
  avg_ms_24h  REAL,
  computed_at TEXT NOT NULL
);

CREATE INDEX ix_sites_is_active     ON sites(is_active);
-- Serves both "latest check for this site" and the 24h window aggregates.
CREATE INDEX ix_checks_site_checked ON checks(site_id, checked_at DESC);
-- Serves the retention sweep, which spans every site.
CREATE INDEX ix_checks_checked_at   ON checks(checked_at);
CREATE INDEX ix_tickets_submitted   ON tickets(submitted_at DESC);
CREATE INDEX ix_tickets_user        ON tickets(user_id);
CREATE INDEX ix_tickets_site        ON tickets(site_id);
CREATE INDEX ix_tickets_status      ON tickets(status);
CREATE INDEX ix_attachments_ticket  ON ticket_attachments(ticket_id);
CREATE INDEX ix_user_sites_site     ON user_sites(site_id);
