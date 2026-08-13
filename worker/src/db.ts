/**
 * D1 data access, replacing the SQLAlchemy layer in app/models.py + app/db.py.
 *
 * Two rules shape the queries here:
 *
 * 1. D1 caps a statement at 100 bound parameters, so anything that could grow
 *    with the data (ticket ids, attachment ids) is filtered with a correlated
 *    subquery rather than an `IN (?, ?, …)` list. Only site ids, which are
 *    bounded by the number of monitored pages, use a placeholder list.
 * 2. Every row read is billed. Lists are capped and aggregates are read from
 *    the `site_stats` rollup rather than recomputed over the check history.
 */

import type {
  AttachmentRow,
  CheckRow,
  CheckStatus,
  SiteRow,
  TicketKind,
  TicketRow,
  TicketStatus,
  TicketView,
  User,
  UserRow,
} from "./types.ts";

/** Upper bound on any ticket listing, so one query cannot scan the table. */
export const TICKET_LIST_LIMIT = 500;

export function nowIso(): string {
  return new Date().toISOString();
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

// --- Users ---------------------------------------------------------------

async function attachSiteIds(db: D1Database, users: UserRow[]): Promise<User[]> {
  if (users.length === 0) return [];

  const { results } = await db
    .prepare(
      `SELECT us.user_id, us.site_id
         FROM user_sites us
         JOIN sites s ON s.id = us.site_id
        ORDER BY s.name`,
    )
    .all<{ user_id: number; site_id: number }>();

  const bySite = new Map<number, number[]>();
  for (const row of results) {
    const list = bySite.get(row.user_id);
    if (list) list.push(row.site_id);
    else bySite.set(row.user_id, [row.site_id]);
  }

  return users.map((user) => ({ ...user, site_ids: bySite.get(user.id) ?? [] }));
}

export async function getUserById(
  db: D1Database,
  id: number,
): Promise<User | null> {
  const row = await db
    .prepare(`SELECT * FROM users WHERE id = ?`)
    .bind(id)
    .first<UserRow>();
  if (!row) return null;

  const { results } = await db
    .prepare(
      `SELECT us.site_id
         FROM user_sites us
         JOIN sites s ON s.id = us.site_id
        WHERE us.user_id = ?
        ORDER BY s.name`,
    )
    .bind(id)
    .all<{ site_id: number }>();

  return { ...row, site_ids: results.map((r) => r.site_id) };
}

export async function getUserByUsername(
  db: D1Database,
  username: string,
): Promise<UserRow | null> {
  return db
    .prepare(`SELECT * FROM users WHERE username = ?`)
    .bind(username)
    .first<UserRow>();
}

export async function listUsers(db: D1Database): Promise<User[]> {
  const { results } = await db
    .prepare(`SELECT * FROM users ORDER BY is_admin DESC, username`)
    .all<UserRow>();
  return attachSiteIds(db, results);
}

export async function createUser(
  db: D1Database,
  input: {
    username: string;
    fullName: string;
    email: string;
    passwordHash: string;
    isAdmin: boolean;
    siteIds: number[];
  },
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO users (username, full_name, email, password_hash, is_admin, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .bind(
      input.username,
      input.fullName,
      input.email,
      input.passwordHash,
      input.isAdmin ? 1 : 0,
      nowIso(),
    )
    .first<{ id: number }>();

  if (!row) throw new Error("User insert returned no id");
  // Page grants are ignored for an admin, who is unrestricted by rule rather
  // than by assignment.
  if (!input.isAdmin) await setUserSites(db, row.id, input.siteIds);
  return row.id;
}

export async function updateUserProfile(
  db: D1Database,
  id: number,
  input: {
    username: string;
    fullName: string;
    email: string;
    isAdmin: boolean;
    passwordHash?: string;
  },
): Promise<void> {
  if (input.passwordHash) {
    await db
      .prepare(
        `UPDATE users
            SET username = ?, full_name = ?, email = ?, is_admin = ?, password_hash = ?
          WHERE id = ?`,
      )
      .bind(
        input.username,
        input.fullName,
        input.email,
        input.isAdmin ? 1 : 0,
        input.passwordHash,
        id,
      )
      .run();
    return;
  }

  await db
    .prepare(
      `UPDATE users SET username = ?, full_name = ?, email = ?, is_admin = ? WHERE id = ?`,
    )
    .bind(input.username, input.fullName, input.email, input.isAdmin ? 1 : 0, id)
    .run();
}

export async function setUserSites(
  db: D1Database,
  userId: number,
  siteIds: number[],
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM user_sites WHERE user_id = ?`).bind(userId),
  ];
  for (const siteId of siteIds) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO user_sites (user_id, site_id) VALUES (?, ?)`,
        )
        .bind(userId, siteId),
    );
  }
  await db.batch(statements);
}

export async function countUsers(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM users`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// --- Sites ---------------------------------------------------------------

export async function listSites(
  db: D1Database,
  options: { activeOnly?: boolean; onlyIds?: number[] | null } = {},
): Promise<SiteRow[]> {
  const { activeOnly = false, onlyIds = null } = options;

  const where: string[] = [];
  const params: unknown[] = [];

  if (activeOnly) where.push(`is_active = 1`);
  if (onlyIds !== null) {
    if (onlyIds.length === 0) return [];
    where.push(`id IN (${placeholders(onlyIds.length)})`);
    params.push(...onlyIds);
  }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { results } = await db
    .prepare(`SELECT * FROM sites ${clause} ORDER BY name`)
    .bind(...params)
    .all<SiteRow>();
  return results;
}

export async function getSite(
  db: D1Database,
  id: number,
): Promise<SiteRow | null> {
  return db.prepare(`SELECT * FROM sites WHERE id = ?`).bind(id).first<SiteRow>();
}

export async function siteSlugExists(
  db: D1Database,
  slug: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS hit FROM sites WHERE slug = ?`)
    .bind(slug)
    .first<{ hit: number }>();
  return row !== null;
}

export async function createSite(
  db: D1Database,
  input: {
    slug: string;
    name: string;
    url: string;
    description: string;
    usesCfAccess: boolean;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sites (slug, name, url, description, is_active, uses_cf_access, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(
      input.slug,
      input.name,
      input.url,
      input.description,
      input.usesCfAccess ? 1 : 0,
      nowIso(),
    )
    .run();
}

export async function updateSite(
  db: D1Database,
  id: number,
  input: {
    name: string;
    url: string;
    description: string;
    isActive: boolean;
    usesCfAccess: boolean;
  },
  options: { clearHistory: boolean },
): Promise<void> {
  const statements = [
    db
      .prepare(
        `UPDATE sites
            SET name = ?, url = ?, description = ?, is_active = ?, uses_cf_access = ?
          WHERE id = ?`,
      )
      .bind(
        input.name,
        input.url,
        input.description,
        input.isActive ? 1 : 0,
        input.usesCfAccess ? 1 : 0,
        id,
      ),
  ];

  if (options.clearHistory) {
    // History describes the old target, so keeping it would show a status that
    // was never measured against the new URL.
    statements.push(db.prepare(`DELETE FROM checks WHERE site_id = ?`).bind(id));
    statements.push(
      db.prepare(`DELETE FROM site_stats WHERE site_id = ?`).bind(id),
    );
  }

  await db.batch(statements);
}

// --- Checks --------------------------------------------------------------

export async function insertChecks(
  db: D1Database,
  rows: Array<{
    siteId: number;
    status: CheckStatus;
    httpStatus: number | null;
    responseMs: number | null;
    detail: string;
  }>,
): Promise<void> {
  if (rows.length === 0) return;
  const checkedAt = nowIso();
  await db.batch(
    rows.map((row) =>
      db
        .prepare(
          `INSERT INTO checks (site_id, checked_at, status, http_status, response_ms, detail)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.siteId,
          checkedAt,
          row.status,
          row.httpStatus,
          row.responseMs,
          row.detail,
        ),
    ),
  );
}

export async function pruneChecks(
  db: D1Database,
  retentionDays: number,
): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  await db.prepare(`DELETE FROM checks WHERE checked_at < ?`).bind(cutoff).run();
}

/**
 * Recompute the 24-hour rollup for every site in one pass.
 *
 * Runs from the cron, right after a round of probes, so the numbers the UI
 * reads are never more than one check interval stale.
 */
export async function refreshSiteStats(db: D1Database): Promise<void> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO site_stats (site_id, uptime_24h, avg_ms_24h, computed_at)
       SELECT site_id,
              ROUND(SUM(CASE WHEN status = 'up' THEN 1.0 ELSE 0.0 END) / COUNT(*) * 100, 2),
              ROUND(AVG(response_ms), 1),
              ?
         FROM checks
        WHERE checked_at >= ?
        GROUP BY site_id
       ON CONFLICT(site_id) DO UPDATE
          SET uptime_24h  = excluded.uptime_24h,
              avg_ms_24h  = excluded.avg_ms_24h,
              computed_at = excluded.computed_at`,
    )
    .bind(nowIso(), since)
    .run();
}

export interface SiteStatsRow {
  site_id: number;
  uptime_24h: number | null;
  avg_ms_24h: number | null;
  computed_at: string;
}

export async function getSiteStats(
  db: D1Database,
  siteIds: number[],
): Promise<Map<number, SiteStatsRow>> {
  if (siteIds.length === 0) return new Map();
  const { results } = await db
    .prepare(
      `SELECT * FROM site_stats WHERE site_id IN (${placeholders(siteIds.length)})`,
    )
    .bind(...siteIds)
    .all<SiteStatsRow>();
  return new Map(results.map((row) => [row.site_id, row]));
}

/**
 * The most recent `limit` checks for each of `siteIds`, oldest first.
 *
 * One windowed query instead of a query per site: the sparkline needs ~30 rows
 * per card and the dashboard renders every card at once.
 */
export async function recentChecksBySite(
  db: D1Database,
  siteIds: number[],
  limit: number,
): Promise<Map<number, CheckRow[]>> {
  if (siteIds.length === 0) return new Map();

  const { results } = await db
    .prepare(
      `SELECT id, site_id, checked_at, status, http_status, response_ms, detail
         FROM (
           SELECT *, ROW_NUMBER() OVER (
                       PARTITION BY site_id ORDER BY checked_at DESC, id DESC
                     ) AS rn
             FROM checks
            WHERE site_id IN (${placeholders(siteIds.length)})
         )
        WHERE rn <= ?
        ORDER BY site_id, checked_at ASC, id ASC`,
    )
    .bind(...siteIds, limit)
    .all<CheckRow>();

  const bySite = new Map<number, CheckRow[]>();
  for (const row of results) {
    const list = bySite.get(row.site_id);
    if (list) list.push(row);
    else bySite.set(row.site_id, [row]);
  }
  return bySite;
}

// --- Tickets -------------------------------------------------------------

const TICKET_SELECT = `
  SELECT t.*,
         s.name      AS site_name,
         s.url       AS site_url,
         u.full_name AS user_full_name,
         u.username  AS user_username
    FROM tickets t
    JOIN sites s ON s.id = t.site_id
    JOIN users u ON u.id = t.user_id
`;

/** A ticket joined to its site and submitter, without the attachments. */
export type TicketJoinRow = TicketRow & {
  site_name: string;
  site_url: string;
  user_full_name: string;
  user_username: string;
};

/**
 * Load the attachments for whichever tickets `ticketFilter` selects.
 *
 * The filter is repeated as a subquery rather than passing the ticket ids back
 * in: a page of 500 tickets would blow past D1's 100-parameter ceiling.
 */
async function attachScreenshots(
  db: D1Database,
  tickets: TicketJoinRow[],
  ticketFilter: { sql: string; params: unknown[] },
): Promise<TicketView[]> {
  if (tickets.length === 0) return [];

  const { results } = await db
    .prepare(
      `SELECT a.*
         FROM ticket_attachments a
        WHERE a.ticket_id IN (${ticketFilter.sql})
        ORDER BY a.ticket_id, a.id`,
    )
    .bind(...ticketFilter.params)
    .all<AttachmentRow>();

  const byTicket = new Map<number, AttachmentRow[]>();
  for (const row of results) {
    const list = byTicket.get(row.ticket_id);
    if (list) list.push(row);
    else byTicket.set(row.ticket_id, [row]);
  }

  return tickets.map((ticket) => ({
    ...ticket,
    attachments: byTicket.get(ticket.id) ?? [],
  }));
}

export async function listTicketsForUser(
  db: D1Database,
  userId: number,
): Promise<TicketView[]> {
  const { results } = await db
    .prepare(
      `${TICKET_SELECT} WHERE t.user_id = ? ORDER BY t.submitted_at DESC LIMIT ?`,
    )
    .bind(userId, TICKET_LIST_LIMIT)
    .all<TicketJoinRow>();

  return attachScreenshots(db, results, {
    sql: `SELECT id FROM tickets WHERE user_id = ? ORDER BY submitted_at DESC LIMIT ?`,
    params: [userId, TICKET_LIST_LIMIT],
  });
}

export async function listAllTickets(
  db: D1Database,
  status: TicketStatus | null,
): Promise<TicketView[]> {
  const where = status ? `WHERE t.status = ?` : "";
  const params = status ? [status, TICKET_LIST_LIMIT] : [TICKET_LIST_LIMIT];

  const { results } = await db
    .prepare(`${TICKET_SELECT} ${where} ORDER BY t.submitted_at DESC LIMIT ?`)
    .bind(...params)
    .all<TicketJoinRow>();

  const innerWhere = status ? `WHERE status = ?` : "";
  return attachScreenshots(db, results, {
    sql: `SELECT id FROM tickets ${innerWhere} ORDER BY submitted_at DESC LIMIT ?`,
    params,
  });
}

export async function recentTickets(
  db: D1Database,
  limit: number,
): Promise<TicketJoinRow[]> {
  const { results } = await db
    .prepare(`${TICKET_SELECT} ORDER BY t.submitted_at DESC LIMIT ?`)
    .bind(limit)
    .all<TicketJoinRow>();
  return results;
}

export async function countOpenTickets(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM tickets WHERE status != 'resolved'`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function createTicket(
  db: D1Database,
  input: {
    siteId: number;
    userId: number;
    subject: string;
    body: string;
    kind: TicketKind;
  },
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO tickets (site_id, user_id, subject, body, kind, status, submitted_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?)
       RETURNING id`,
    )
    .bind(
      input.siteId,
      input.userId,
      input.subject,
      input.body,
      input.kind,
      nowIso(),
    )
    .first<{ id: number }>();

  if (!row) throw new Error("Ticket insert returned no id");
  return row.id;
}

export async function insertAttachments(
  db: D1Database,
  ticketId: number,
  rows: Array<{
    filename: string;
    contentType: string;
    sizeBytes: number;
    r2Key: string;
  }>,
): Promise<void> {
  if (rows.length === 0) return;
  const uploadedAt = nowIso();
  await db.batch(
    rows.map((row) =>
      db
        .prepare(
          `INSERT INTO ticket_attachments
             (ticket_id, filename, content_type, size_bytes, r2_key, uploaded_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          ticketId,
          row.filename,
          row.contentType,
          row.sizeBytes,
          row.r2Key,
          uploadedAt,
        ),
    ),
  );
}

export async function updateTicketStatus(
  db: D1Database,
  ticketId: number,
  status: TicketStatus,
): Promise<void> {
  await db
    .prepare(`UPDATE tickets SET status = ? WHERE id = ?`)
    .bind(status, ticketId)
    .run();
}

export async function getTicketForSync(
  db: D1Database,
  ticketId: number,
): Promise<TicketJoinRow | null> {
  return db
    .prepare(`${TICKET_SELECT} WHERE t.id = ?`)
    .bind(ticketId)
    .first<TicketJoinRow>();
}

export async function recordOdooSuccess(
  db: D1Database,
  ticketId: number,
  odooId: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE tickets SET odoo_id = ?, odoo_synced_at = ?, odoo_error = '' WHERE id = ?`,
    )
    .bind(odooId, nowIso(), ticketId)
    .run();
}

export async function recordOdooFailure(
  db: D1Database,
  ticketId: number,
  message: string,
): Promise<void> {
  await db
    .prepare(`UPDATE tickets SET odoo_error = ? WHERE id = ?`)
    .bind(message.slice(0, 512), ticketId)
    .run();
}

// --- Attachments ---------------------------------------------------------

/** An attachment with the id of the account that submitted its ticket. */
export async function getAttachmentWithOwner(
  db: D1Database,
  attachmentId: number,
): Promise<(AttachmentRow & { owner_id: number }) | null> {
  return db
    .prepare(
      `SELECT a.*, t.user_id AS owner_id
         FROM ticket_attachments a
         JOIN tickets t ON t.id = a.ticket_id
        WHERE a.id = ?`,
    )
    .bind(attachmentId)
    .first<AttachmentRow & { owner_id: number }>();
}
