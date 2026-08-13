/**
 * View models shared by the client status page and the admin dashboard,
 * ported from app/presenters.py.
 */

import { getSiteStats, listSites, recentChecksBySite } from "./db.ts";
import type { CheckRow, CheckStatus, SiteRow } from "./types.ts";

export interface SiteCard {
  site: SiteRow;
  status: CheckStatus | null;
  detail: string;
  checkedAt: string | null;
  responseMs: number | null;
  uptime24h: number | null;
  avgMs24h: number | null;
  history: CheckRow[];
}

export function statusValue(card: SiteCard): string {
  return card.status ?? "pending";
}

/**
 * Build the status cards.
 *
 * `onlySiteIds` of null means no restriction; an empty array means no pages,
 * which is what an unassigned client sees.
 *
 * Three queries regardless of how many pages are configured: the sites, one
 * windowed pass over the recent checks, and the precomputed 24h rollup.
 */
export async function buildSiteCards(
  db: D1Database,
  options: {
    includeInactive?: boolean;
    historyLimit?: number;
    onlySiteIds?: number[] | null;
  } = {},
): Promise<SiteCard[]> {
  const {
    includeInactive = false,
    historyLimit = 30,
    onlySiteIds = null,
  } = options;

  const sites = await listSites(db, {
    activeOnly: !includeInactive,
    onlyIds: onlySiteIds,
  });
  if (sites.length === 0) return [];

  const siteIds = sites.map((site) => site.id);
  const [history, stats] = await Promise.all([
    recentChecksBySite(db, siteIds, historyLimit),
    getSiteStats(db, siteIds),
  ]);

  return sites.map((site) => {
    const checks = history.get(site.id) ?? [];
    // recentChecksBySite returns oldest-first for the sparkline, so the newest
    // check — the one the card reports — is the last element.
    const last = checks.length > 0 ? checks[checks.length - 1]! : null;
    const rollup = stats.get(site.id);

    return {
      site,
      status: last?.status ?? null,
      detail: last?.detail ?? "",
      checkedAt: last?.checked_at ?? null,
      responseMs: last?.response_ms ?? null,
      uptime24h: rollup?.uptime_24h ?? null,
      avgMs24h: rollup?.avg_ms_24h ?? null,
      history: checks,
    };
  });
}

export interface Summary {
  total: number;
  up: number;
  degraded: number;
  down: number;
  pending: number;
}

export function summarize(cards: SiteCard[]): Summary {
  return {
    total: cards.length,
    up: cards.filter((c) => c.status === "up").length,
    degraded: cards.filter((c) => c.status === "degraded").length,
    down: cards.filter((c) => c.status === "down").length,
    pending: cards.filter((c) => c.status === null).length,
  };
}
