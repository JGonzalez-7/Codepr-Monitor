/**
 * Presentation helpers — the Jinja2 filters from app/templating.py.
 *
 * Client-facing wording lives here so "degraded" never gets rendered as
 * anything that claims the site is up.
 */

import type { CheckStatus, TicketStatus } from "./types.ts";

const STATUS_LABELS: Record<CheckStatus, string> = {
  up: "Online",
  degraded: "Needs attention",
  down: "Offline",
};

const STATUS_BLURBS: Record<CheckStatus, string> = {
  up: "This page is loading normally.",
  degraded:
    "We reached the server but could not confirm the page is healthy.",
  down: "We could not load this page.",
};

const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
};

export function statusLabel(status: CheckStatus | null): string {
  return status === null ? "Checking…" : STATUS_LABELS[status];
}

export function statusBlurb(status: CheckStatus | null): string {
  return status === null
    ? "The first check has not completed yet."
    : STATUS_BLURBS[status];
}

export function ticketStatusLabel(status: TicketStatus): string {
  return TICKET_STATUS_LABELS[status];
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Render a timestamp for display, in UTC, with an explicit suffix. */
export function formatDt(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";

  return (
    `${MONTHS[date.getUTCMonth()]} ${pad(date.getUTCDate())}, ` +
    `${date.getUTCFullYear()} at ${pad(date.getUTCHours())}:` +
    `${pad(date.getUTCMinutes())} UTC`
  );
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "never";

  const seconds = (Date.now() - date.getTime()) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

/** "1 page" / "2 pages" — the pluralisation the status banner needs. */
export function plural(count: number, singular: string, suffix = "s"): string {
  return count === 1 ? singular : `${singular}${suffix}`;
}
