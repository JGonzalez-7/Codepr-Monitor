/** Client status page, ported from app/templates/status.html. */

import { raw } from "hono/html";

import { plural } from "../format.ts";
import type { SiteCard as Card, Summary } from "../presenters.ts";
import type { User } from "../types.ts";
import { Layout } from "./layout.tsx";
import { SiteCard } from "./siteCard.tsx";

// Poll for fresh results so the page reflects the checker without a reload.
// Static — no interpolated values — so it carries nothing client-supplied.
const REFRESH_SCRIPT = `
  const LABELS = { up: 'Online', degraded: 'Needs attention', down: 'Offline', pending: 'Checking…' };

  async function refresh() {
    let data;
    try {
      const response = await fetch('/api/status', { headers: { 'Accept': 'application/json' } });
      if (!response.ok) return;          // session expired or server hiccup — try again next tick
      data = await response.json();
    } catch { return; }                  // offline browser; keep the last known state on screen

    for (const site of data.sites) {
      const card = document.querySelector(\`[data-slug="\${CSS.escape(site.slug)}"]\`);
      if (!card) continue;

      const pill = card.querySelector('[data-role="pill"]');
      pill.className = \`pill \${site.status}\`;
      pill.querySelector('[data-role="label"]').textContent = LABELS[site.status] || site.label;

      card.querySelector('[data-role="blurb"]').textContent = site.blurb;
      const detail = card.querySelector('[data-role="detail"]');
      if (detail) detail.textContent = site.detail;
    }

    const banner = document.querySelector('[data-role="banner"]');
    if (!banner) return;
    const { down, degraded } = data.summary;
    if (down > 0) {
      banner.className = 'banner trouble';
      banner.querySelector('[data-role="banner-title"]').textContent =
        \`\${down} page\${down === 1 ? '' : 's'} offline\`;
      banner.querySelector('[data-role="banner-sub"]').textContent =
        'Our team can see this too. You can submit a ticket with any details.';
    } else if (degraded > 0) {
      banner.className = 'banner warn';
      banner.querySelector('[data-role="banner-title"]').textContent =
        \`\${degraded} page\${degraded === 1 ? '' : 's'} need attention\`;
      banner.querySelector('[data-role="banner-sub"]').textContent =
        'We reached the server but could not confirm the page is healthy.';
    } else {
      banner.className = 'banner all-good';
      banner.querySelector('[data-role="banner-title"]').textContent = 'All pages are online';
      banner.querySelector('[data-role="banner-sub"]').textContent =
        'Everything we monitor is loading normally.';
    }
  }

  setInterval(refresh, 30000);
`;

function Banner({ summary }: { summary: Summary }) {
  const trouble = summary.down > 0;
  const warning = summary.degraded > 0;
  const tone = trouble ? "trouble" : warning ? "warn" : "all-good";

  let title: string;
  let sub: string;
  if (trouble) {
    title = `${summary.down} ${plural(summary.down, "page")} offline`;
    sub = "Our team can see this too. You can submit a ticket with any details.";
  } else if (warning) {
    title = `${summary.degraded} ${plural(summary.degraded, "page")} need attention`;
    sub = "We reached the server but could not confirm the page is healthy.";
  } else {
    title = "All pages are online";
    sub = "Everything we monitor is loading normally.";
  }

  return (
    <div class={`banner ${tone}`} data-role="banner" role="status">
      <div>
        <strong data-role="banner-title">{title}</strong>
        <div class="banner-sub" data-role="banner-sub">
          {sub}
        </div>
      </div>
    </div>
  );
}

export function StatusPage({
  user,
  impersonator,
  cards,
  summary,
}: {
  user: User;
  impersonator: User | null;
  cards: Card[];
  summary: Summary;
}) {
  const hasCards = cards.length > 0;

  return (
    <Layout
      title="Page Status · CodePR-Monitor"
      user={user}
      impersonator={impersonator}
      path="/status"
      scripts={<script>{raw(REFRESH_SCRIPT)}</script>}
    >
      <div class="page-head">
        <h1>Your pages</h1>
        <p>We check each page automatically and refresh this view on its own.</p>
      </div>

      {hasCards && <Banner summary={summary} />}

      {hasCards ? (
        <div class="card-grid">
          {cards.map((card) => (
            <SiteCard card={card} />
          ))}
        </div>
      ) : user.is_admin === 1 ? (
        <div class="table-wrap">
          <p class="empty">No pages are being monitored yet.</p>
        </div>
      ) : (
        <div class="table-wrap">
          <p class="empty">
            No pages have been assigned to your account yet. Ask CodePR to give
            you access to the pages you are responsible for.
          </p>
        </div>
      )}

      {hasCards && (
        <div class="section">
          <h2>Something looks wrong?</h2>
          <p class="muted">Tell us what you are seeing and we will pick it up.</p>
          <a class="btn" href="/tickets">
            Submit a ticket
          </a>
        </div>
      )}
    </Layout>
  );
}
