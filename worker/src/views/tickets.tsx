/** Client ticket page, ported from app/templates/tickets.html. */

import { ACCEPT_ATTRIBUTE } from "../attachments.ts";
import { formatDt, ticketStatusLabel } from "../format.ts";
import type { SiteRow, TicketView, User } from "../types.ts";
import { Layout } from "./layout.tsx";

export function Thumbs({ ticket }: { ticket: TicketView }) {
  if (ticket.attachments.length === 0) return null;
  return (
    <div class="thumbs">
      {ticket.attachments.map((shot) => (
        <a
          class="thumb"
          href={`/tickets/attachments/${shot.id}`}
          target="_blank"
          rel="noopener"
          title={shot.filename}
        >
          <img
            src={`/tickets/attachments/${shot.id}`}
            alt={shot.filename}
            loading="lazy"
          />
        </a>
      ))}
    </div>
  );
}

export function TicketsPage({
  user,
  impersonator,
  sites,
  tickets,
  submittedId,
  error,
  maxAttachments,
  maxAttachmentMb,
  truncated,
}: {
  user: User;
  impersonator: User | null;
  sites: SiteRow[];
  tickets: TicketView[];
  submittedId: number | null;
  error: string | null;
  maxAttachments: number;
  maxAttachmentMb: number;
  truncated: boolean;
}) {
  return (
    <Layout
      title="My Tickets · CodePR-Monitor"
      user={user}
      impersonator={impersonator}
      path="/tickets"
    >
      <div class="page-head">
        <h1>Tickets</h1>
        <p>Report a problem with a page, or request a fix or change.</p>
      </div>

      {submittedId !== null && (
        <div class="alert success" role="status">
          Ticket #{submittedId} was submitted. We recorded the date, time, your
          name, and the page it is for.
        </div>
      )}

      {error && (
        <div class="alert error" role="alert">
          {error}
        </div>
      )}

      {sites.length === 0 ? (
        <div class="table-wrap">
          <p class="empty">
            No pages have been assigned to your account yet, so there is nothing
            to raise a ticket about. Ask CodePR to give you access first.
          </p>
        </div>
      ) : (
        <div class="form-card">
          <form method="post" action="/tickets" enctype="multipart/form-data">
            <div class="field">
              <label for="site_id">Which page is this about?</label>
              <select id="site_id" name="site_id" required>
                <option value="" disabled selected>
                  Choose a page…
                </option>
                {sites.map((site) => (
                  <option value={String(site.id)}>
                    {site.name} — {site.url}
                  </option>
                ))}
              </select>
            </div>

            <div class="field">
              <label>What kind of ticket is this?</label>
              <div class="radio-row">
                <label>
                  <input type="radio" name="kind" value="issue" checked /> Something
                  is broken
                </label>
                <label>
                  <input type="radio" name="kind" value="fix" /> I want a fix or
                  change
                </label>
              </div>
            </div>

            <div class="field">
              <label for="subject">Subject</label>
              <input
                type="text"
                id="subject"
                name="subject"
                maxlength={200}
                required
                placeholder="Short summary, e.g. Contact form does not send"
              />
            </div>

            <div class="field">
              <label for="body">Details</label>
              <textarea
                id="body"
                name="body"
                placeholder="What did you expect, and what happened instead? Steps to reproduce help a lot."
              ></textarea>
            </div>

            <div class="field">
              <label for="screenshots">
                Screenshots <span class="muted">(optional)</span>
              </label>
              <input
                type="file"
                id="screenshots"
                name="screenshots"
                multiple
                accept={ACCEPT_ATTRIBUTE}
              />
              <p class="hint">
                Up to {maxAttachments} images, {Math.round(maxAttachmentMb)} MB each
                — PNG, JPEG, GIF, or WebP. Showing the problem is usually faster
                than describing it.
              </p>
              <p class="hint">
                Your name and the submission date and time are attached
                automatically.
              </p>
            </div>

            <button class="btn" type="submit">
              Submit ticket
            </button>
          </form>
        </div>
      )}

      <div class="section">
        <h2>Your Tickets</h2>
        <div class="table-wrap">
          {tickets.length > 0 ? (
            <>
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Page</th>
                    <th>Subject</th>
                    <th>Type</th>
                    <th>Submitted</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {tickets.map((ticket) => (
                    <tr>
                      <td class="muted">{ticket.id}</td>
                      <td class="nowrap">{ticket.site_name}</td>
                      <td>
                        {ticket.subject}
                        {ticket.body && (
                          <div class="muted">
                            {ticket.body.slice(0, 140)}
                            {ticket.body.length > 140 ? "…" : ""}
                          </div>
                        )}
                        <Thumbs ticket={ticket} />
                      </td>
                      <td>
                        <span class={`tag ${ticket.kind}`}>
                          {ticket.kind === "issue" ? "Issue" : "Fix"}
                        </span>
                      </td>
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
              {truncated && (
                <p class="muted">
                  Showing your {tickets.length} most recent tickets.
                </p>
              )}
            </>
          ) : (
            <p class="empty">You have not submitted any tickets yet.</p>
          )}
        </div>
      </div>
    </Layout>
  );
}
