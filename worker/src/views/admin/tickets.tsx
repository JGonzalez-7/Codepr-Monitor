/** Admin ticket queue, ported from app/templates/admin/tickets.html. */

import { formatDt, ticketStatusLabel } from "../../format.ts";
import { TICKET_STATUSES, type TicketView, type User } from "../../types.ts";
import { Layout } from "../layout.tsx";
import { Thumbs } from "../tickets.tsx";

export function AdminTicketsPage({
  user,
  impersonator,
  tickets,
  activeFilter,
  odooEnabled,
  truncated,
}: {
  user: User;
  impersonator: User | null;
  tickets: TicketView[];
  activeFilter: string;
  odooEnabled: boolean;
  truncated: boolean;
}) {
  return (
    <Layout
      title="Tickets · CodePR-Monitor"
      user={user}
      impersonator={impersonator}
      path="/admin/tickets"
    >
      <div class="page-head">
        <h1>Ticket queue</h1>
        <p>Every ticket submitted by a client, newest first.</p>
      </div>

      <div class="filters">
        <a
          href="/admin/tickets"
          class={activeFilter === "all" ? "is-active" : ""}
        >
          All
        </a>
        {TICKET_STATUSES.map((status) => (
          <a
            href={`/admin/tickets?status=${status}`}
            class={activeFilter === status ? "is-active" : ""}
          >
            {ticketStatusLabel(status)}
          </a>
        ))}
      </div>

      <div class="table-wrap">
        {tickets.length > 0 ? (
          <>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Page</th>
                  <th>Subject</th>
                  <th>Submitted by</th>
                  <th>Submitted</th>
                  <th>Type</th>
                  <th>Status</th>
                  {odooEnabled && <th>Odoo</th>}
                </tr>
              </thead>
              <tbody>
                {tickets.map((ticket) => (
                  <tr>
                    <td class="muted">{ticket.id}</td>
                    <td class="nowrap">
                      {ticket.site_name}
                      <div class="muted">{ticket.site_url}</div>
                    </td>
                    <td>
                      {ticket.subject}
                      {ticket.body && <div class="muted">{ticket.body}</div>}
                      <Thumbs ticket={ticket} />
                    </td>
                    <td class="nowrap">
                      {ticket.user_full_name}
                      <div class="muted">{ticket.user_username}</div>
                    </td>
                    <td class="nowrap">{formatDt(ticket.submitted_at)}</td>
                    <td>
                      <span class={`tag ${ticket.kind}`}>
                        {ticket.kind === "issue" ? "Issue" : "Fix"}
                      </span>
                    </td>
                    <td>
                      <form
                        class="inline-form"
                        method="post"
                        action={`/admin/tickets/${ticket.id}/status`}
                      >
                        <select
                          name="status"
                          aria-label={`Status for ticket ${ticket.id}`}
                        >
                          {TICKET_STATUSES.map((status) => (
                            <option
                              value={status}
                              selected={ticket.status === status}
                            >
                              {ticketStatusLabel(status)}
                            </option>
                          ))}
                        </select>
                        <button class="btn btn-ghost btn-small" type="submit">
                          Save
                        </button>
                      </form>
                    </td>
                    {odooEnabled && (
                      <td class="nowrap">
                        {ticket.odoo_id ? (
                          <span class="tag resolved">#{ticket.odoo_id}</span>
                        ) : (
                          <>
                            <form
                              class="inline-form"
                              method="post"
                              action={`/admin/tickets/${ticket.id}/resync`}
                            >
                              <button
                                class="btn btn-ghost btn-small"
                                type="submit"
                              >
                                Retry
                              </button>
                            </form>
                            {ticket.odoo_error && (
                              <div class="muted">{ticket.odoo_error}</div>
                            )}
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {truncated && (
              <p class="muted">
                Showing the {tickets.length} most recent tickets that match this
                filter.
              </p>
            )}
          </>
        ) : (
          <p class="empty">No tickets match this filter.</p>
        )}
      </div>
    </Layout>
  );
}
