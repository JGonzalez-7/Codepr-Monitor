/** Bindings, row shapes, and the domain enums the app is built around. */

export interface Env {
  DB: D1Database;
  SCREENSHOTS: R2Bucket;

  // --- Secrets (wrangler secret put) ---
  /**
   * Signs session cookies. The Worker refuses to start a session without one,
   * because an unsigned or predictably signed cookie can be forged into an
   * admin session.
   */
  SECRET_KEY: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  ODOO_DB?: string;
  ODOO_USERNAME?: string;
  ODOO_PASSWORD?: string;

  // --- Vars (wrangler.jsonc) ---
  SESSION_COOKIE_NAME?: string;
  SESSION_MAX_AGE_SECONDS?: string;
  CHECK_INTERVAL_SECONDS?: string;
  REQUEST_TIMEOUT_SECONDS?: string;
  HISTORY_RETENTION_DAYS?: string;
  MAX_ATTACHMENT_MB?: string;
  MAX_ATTACHMENTS_PER_TICKET?: string;
  PBKDF2_ITERATIONS?: string;
  UPTIME_KUMA_EMBED_URL?: string;
  ODOO_ENABLED?: string;
  ODOO_URL?: string;
}

/**
 * Outcome of a single probe.
 *
 * `degraded` covers "reachable, but the response does not prove the app is
 * healthy" — most importantly a Cloudflare Access login redirect, which would
 * otherwise be indistinguishable from a healthy 200.
 */
export type CheckStatus = "up" | "degraded" | "down";
export const CHECK_STATUSES: CheckStatus[] = ["up", "degraded", "down"];

export type TicketKind = "issue" | "fix";
export const TICKET_KINDS: TicketKind[] = ["issue", "fix"];

export type TicketStatus = "open" | "in_progress" | "resolved";
export const TICKET_STATUSES: TicketStatus[] = ["open", "in_progress", "resolved"];

export function isTicketStatus(value: string): value is TicketStatus {
  return (TICKET_STATUSES as string[]).includes(value);
}

export function isTicketKind(value: string): value is TicketKind {
  return (TICKET_KINDS as string[]).includes(value);
}

/** D1 returns booleans as 0/1 integers. */
export type SqlBool = 0 | 1;

export interface UserRow {
  id: number;
  username: string;
  full_name: string;
  email: string;
  password_hash: string;
  is_admin: SqlBool;
  created_at: string;
}

/** A user with their assigned pages resolved. Admins carry an empty list. */
export interface User extends UserRow {
  site_ids: number[];
}

export interface SiteRow {
  id: number;
  slug: string;
  name: string;
  url: string;
  description: string;
  is_active: SqlBool;
  uses_cf_access: SqlBool;
  created_at: string;
}

export interface CheckRow {
  id: number;
  site_id: number;
  checked_at: string;
  status: CheckStatus;
  http_status: number | null;
  response_ms: number | null;
  detail: string;
}

export interface TicketRow {
  id: number;
  site_id: number;
  user_id: number;
  subject: string;
  body: string;
  kind: TicketKind;
  status: TicketStatus;
  submitted_at: string;
  odoo_id: number | null;
  odoo_synced_at: string | null;
  odoo_error: string;
}

export interface AttachmentRow {
  id: number;
  ticket_id: number;
  filename: string;
  content_type: string;
  size_bytes: number;
  r2_key: string;
  uploaded_at: string;
}

/** A ticket joined to the site and submitter it is rendered with. */
export interface TicketView extends TicketRow {
  site_name: string;
  site_url: string;
  user_full_name: string;
  user_username: string;
  attachments: AttachmentRow[];
}

/**
 * Hono context variables. `user` is the *effective* user: while an admin is
 * impersonating, it is the account being acted as, so every permission check —
 * including requireAdmin — measures them rather than the admin behind them.
 */
export type Variables = {
  user: User | null;
  impersonator: User | null;
};

export type AppEnv = { Bindings: Env; Variables: Variables };
