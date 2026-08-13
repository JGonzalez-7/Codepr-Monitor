/**
 * Application settings, read from the Worker environment.
 *
 * The Python app read these once at import time. A Worker gets `env` per
 * request instead, so settings are derived per call — cheap, and it keeps
 * secrets out of module scope.
 */

import type { Env } from "./types.ts";

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
}

export interface Settings {
  sessionCookieName: string;
  sessionMaxAgeSeconds: number;

  checkIntervalSeconds: number;
  requestTimeoutSeconds: number;
  historyRetentionDays: number;

  cfAccessClientId: string;
  cfAccessClientSecret: string;
  hasCfAccessToken: boolean;

  maxAttachmentMb: number;
  maxAttachmentBytes: number;
  maxAttachmentsPerTicket: number;

  pbkdf2Iterations: number;

  uptimeKumaEmbedUrl: string;

  odooEnabled: boolean;
  odooUrl: string;
  odooDb: string;
  odooUsername: string;
  odooPassword: string;
}

export function getSettings(env: Env): Settings {
  const cfId = env.CF_ACCESS_CLIENT_ID ?? "";
  const cfSecret = env.CF_ACCESS_CLIENT_SECRET ?? "";
  const maxAttachmentMb = num(env.MAX_ATTACHMENT_MB, 5);

  return {
    sessionCookieName: env.SESSION_COOKIE_NAME || "codepr_session",
    sessionMaxAgeSeconds: num(env.SESSION_MAX_AGE_SECONDS, 60 * 60 * 12),

    checkIntervalSeconds: num(env.CHECK_INTERVAL_SECONDS, 60),
    requestTimeoutSeconds: num(env.REQUEST_TIMEOUT_SECONDS, 15),
    historyRetentionDays: num(env.HISTORY_RETENTION_DAYS, 30),

    cfAccessClientId: cfId,
    cfAccessClientSecret: cfSecret,
    hasCfAccessToken: Boolean(cfId && cfSecret),

    maxAttachmentMb,
    maxAttachmentBytes: Math.floor(maxAttachmentMb * 1024 * 1024),
    maxAttachmentsPerTicket: num(env.MAX_ATTACHMENTS_PER_TICKET, 3),

    pbkdf2Iterations: num(env.PBKDF2_ITERATIONS, 100_000),

    uptimeKumaEmbedUrl: env.UPTIME_KUMA_EMBED_URL || "http://localhost:3001",

    odooEnabled: bool(env.ODOO_ENABLED, false),
    odooUrl: env.ODOO_URL || "https://odoo.code.pr",
    odooDb: env.ODOO_DB ?? "",
    odooUsername: env.ODOO_USERNAME ?? "",
    odooPassword: env.ODOO_PASSWORD ?? "",
  };
}
