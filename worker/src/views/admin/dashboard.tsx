/** Admin fleet overview, ported from app/templates/admin/dashboard.html. */

import type { TicketJoinRow } from "../../db.ts";
import { formatDt, ticketStatusLabel } from "../../format.ts";
import type { SiteCard as Card, Summary } from "../../presenters.ts";
import type { User } from "../../types.ts";
import { Layout } from "../layout.tsx";
import { SiteCard } from "../siteCard.tsx";

export function DashboardPage({
  user,
  impersonator,
  cards,
  summary,
  openTickets,
  recentTickets,
  checkInterval,
  cfTokenConfigured,
  odooEnabled,
}: {
  user: User;
  impersonator: User | null;
  cards: Card[];
  summary: Summary;
  openTickets: number;
  recentTickets: TicketJoinRow[];
  checkInterval: number;
  cfTokenConfigured: boolean;
  odooEnabled: boolean;
}) {
  return (
    <Layout
      title="Dashboard · CodePR-Monitor"
      user={user}
      impersonator={impersonator}
      path="/admin"
    >
      <div class="page-head">
        <h1>Monitoring dashboard</h1>
        <p>Every monitored page, checked every {checkInterval} seconds.</p>
      </div>

      <div class="stat-row">
        <div class="stat">
          <div class="stat-value">{summary.total}</div>
          <div class="stat-label">Pages</div>
        </div>
        <div class="stat up">
          <div class="stat-value">{summary.up}</div>
          <div class="stat-label">Online</div>
        </div>
        <div class="stat degraded">
          <div class="stat-value">{summary.degraded}</div>
          <div class="stat-label">Need attention</div>
        </div>
        <div class="stat down">
          <div class="stat-value">{summary.down}</div>
          <div class="stat-label">Offline</div>
        </div>
        <div class="stat">
          <div class="stat-value">{openTickets}</div>
          <div class="stat-label">Open tickets</div>
        </div>
      </div>

      {!cfTokenConfigured && (
        <div class="alert info">
          <strong>Cloudflare Access token not configured.</strong> odoo.code.pr
          sits behind Cloudflare Zero Trust, so checks only reach the Access login
          page and cannot confirm Odoo itself is healthy. Set{" "}
          <code>CF_ACCESS_CLIENT_ID</code> and <code>CF_ACCESS_CLIENT_SECRET</code>{" "}
          with <code>wrangler secret put</code>, and authorize that service token
          on the odoo.code.pr application.
        </div>
      )}

      {!odooEnabled && (
        <div class="alert info">
          <strong>Odoo mirroring is off.</strong> Tickets are stored locally only.
          Set <code>ODOO_ENABLED=true</code> plus the <code>ODOO_*</code>{" "}
          credentials to mirror them into the <code>codepr.monitor.ticket</code>{" "}
          model.
        </div>
      )}

      <form method="post" action="/admin/check-now" style="margin-bottom:1.25rem">
        <button class="btn" type="submit">
          Run all checks now
        </button>
      </form>

      <div class="card-grid">
        {cards.length > 0 ? (
          cards.map((card) => <SiteCard card={card} />)
        ) : (
          <div class="table-wrap">
            <p class="empty">
              No pages configured. Add one under <a href="/admin/sites">Pages</a>.
            </p>
          </div>
        )}
      </div>

      <div class="section">
        <h2>Latest tickets</h2>
        <div class="table-wrap">
          {recentTickets.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Page</th>
                  <th>Subject</th>
                  <th>Submitted by</th>
                  <th>Submitted</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {recentTickets.map((ticket) => (
                  <tr>
                    <td class="muted">{ticket.id}</td>
                    <td class="nowrap">{ticket.site_name}</td>
                    <td>{ticket.subject}</td>
                    <td class="nowrap">{ticket.user_full_name}</td>
                    <td class="nowrap">{formatDt(ticket.submitted_at)}</td>
                    <td>
                      <span class={`tag ${ticket.status}`}>
                        {ticketStatusLabel(ticket.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p class="empty">No tickets submitted yet.</p>
          )}
        </div>
        <p style="margin-top:1rem">
          <a href="/admin/tickets">View the full ticket queue →</a>
        </p>
      </div>
    </Layout>
  );
}
