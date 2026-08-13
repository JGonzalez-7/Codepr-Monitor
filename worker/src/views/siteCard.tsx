/** Shared status card, ported from app/templates/_site_card.html. */

import { formatDt, statusBlurb, statusLabel, timeAgo } from "../format.ts";
import { statusValue, type SiteCard as Card } from "../presenters.ts";

export function SiteCard({ card }: { card: Card }) {
  return (
    <article
      class={`site-card ${card.site.is_active === 1 ? "" : "is-inactive"}`}
      data-slug={card.site.slug}
    >
      <div class="site-card-head">
        <div>
          <h3>{card.site.name}</h3>
          <a
            class="site-url"
            href={card.site.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {card.site.url}
          </a>
        </div>
        <span class={`pill ${statusValue(card)}`} data-role="pill">
          <span class="dot" aria-hidden="true"></span>
          <span data-role="label">{statusLabel(card.status)}</span>
        </span>
      </div>

      <p class="site-blurb" data-role="blurb">
        {statusBlurb(card.status)}
      </p>

      {card.detail && (
        <p class="site-detail" data-role="detail">
          {card.detail}
        </p>
      )}

      {card.history.length > 0 && (
        <div
          class="spark"
          role="img"
          aria-label="Recent check history, oldest to newest"
        >
          {card.history.map((check) => (
            <span
              class={check.status}
              title={`${formatDt(check.checked_at)} — ${check.detail}`}
            ></span>
          ))}
        </div>
      )}

      <div class="metrics">
        <div>
          <span class="metric-label">Uptime 24h</span>
          <span class="metric-value">
            {card.uptime24h === null ? "—" : `${card.uptime24h}%`}
          </span>
        </div>
        <div>
          <span class="metric-label">Response</span>
          <span class="metric-value">
            {card.responseMs === null ? "—" : `${Math.round(card.responseMs)} ms`}
          </span>
        </div>
        <div>
          <span class="metric-label">Last checked</span>
          <span class="metric-value">{timeAgo(card.checkedAt)}</span>
        </div>
      </div>
    </article>
  );
}
