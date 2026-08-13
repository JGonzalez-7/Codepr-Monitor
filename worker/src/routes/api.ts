/** JSON endpoints backing live refresh, plus the health probe. Ported from routers/api.py. */

import { Hono } from "hono";

import { visibleSiteIds } from "../access.ts";
import { statusBlurb, statusLabel } from "../format.ts";
import { buildSiteCards, statusValue, summarize } from "../presenters.ts";
import { currentUser, requireUser } from "../security.ts";
import type { AppEnv } from "../types.ts";

export const apiRoutes = new Hono<AppEnv>();

apiRoutes.get("/healthz", (c) => c.json({ status: "ok" }));

/**
 * Current status of every visible site, polled by the status page.
 *
 * Filtered the same way as the page itself — the poll must not hand a client
 * the status of pages they cannot see.
 */
apiRoutes.get("/api/status", requireUser, async (c) => {
  const user = currentUser(c);
  const cards = await buildSiteCards(c.env.DB, {
    includeInactive: user.is_admin === 1,
    historyLimit: 1,
    onlySiteIds: visibleSiteIds(user),
  });

  return c.json({
    summary: summarize(cards),
    sites: cards.map((card) => ({
      slug: card.site.slug,
      name: card.site.name,
      url: card.site.url,
      status: statusValue(card),
      label: statusLabel(card.status),
      blurb: statusBlurb(card.status),
      detail: card.detail,
      checked_at: card.checkedAt,
      response_ms: card.responseMs,
      uptime_24h: card.uptime24h,
    })),
  });
});
