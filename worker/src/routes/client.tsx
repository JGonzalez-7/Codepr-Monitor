/** Client-facing pages: page status and ticket submission. Ported from routers/client.py. */

import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";

import { accessibleSites, canAccess, visibleSiteIds } from "../access.ts";
import {
  AttachmentError,
  collectScreenshots,
  type ValidatedImage,
} from "../attachments.ts";
import { getSettings } from "../config.ts";
import {
  createTicket,
  getAttachmentWithOwner,
  getSite,
  insertAttachments,
  listTicketsForUser,
  TICKET_LIST_LIMIT,
} from "../db.ts";
import { syncTicketBackground } from "../odoo.ts";
import { buildSiteCards, summarize } from "../presenters.ts";
import { currentUser, requireUser } from "../security.ts";
import { isTicketKind, type AppEnv } from "../types.ts";
import { StatusPage } from "../views/status.tsx";
import { TicketsPage } from "../views/tickets.tsx";

export const clientRoutes = new Hono<AppEnv>();

clientRoutes.use("/status", requireUser);
clientRoutes.use("/tickets", requireUser);
clientRoutes.use("/tickets/*", requireUser);

clientRoutes.get("/status", async (c) => {
  const user = currentUser(c);
  const cards = await buildSiteCards(c.env.DB, {
    onlySiteIds: visibleSiteIds(user),
  });

  return c.html(
    <StatusPage
      user={user}
      impersonator={c.get("impersonator")}
      cards={cards}
      summary={summarize(cards)}
    />,
  );
});

async function renderTickets(
  c: Context<AppEnv>,
  options: {
    submittedId?: number | null;
    error?: string | null;
    statusCode?: 200 | 400 | 403;
  } = {},
) {
  const { submittedId = null, error = null, statusCode = 200 } = options;
  const user = currentUser(c);
  const settings = getSettings(c.env);

  const [sites, tickets] = await Promise.all([
    accessibleSites(c.env.DB, user),
    listTicketsForUser(c.env.DB, user.id),
  ]);

  return c.html(
    <TicketsPage
      user={user}
      impersonator={c.get("impersonator")}
      sites={sites}
      tickets={tickets}
      submittedId={submittedId}
      error={error}
      maxAttachments={settings.maxAttachmentsPerTicket}
      maxAttachmentMb={settings.maxAttachmentMb}
      truncated={tickets.length >= TICKET_LIST_LIMIT}
    />,
    statusCode,
  );
}

clientRoutes.get("/tickets", async (c) => {
  const submitted = Number(c.req.query("submitted"));
  return renderTickets(c, {
    submittedId: Number.isInteger(submitted) && submitted > 0 ? submitted : null,
  });
});

/** Serve one screenshot to its submitter, or to any admin. */
clientRoutes.get("/tickets/attachments/:id", async (c) => {
  const user = currentUser(c);
  const attachmentId = Number(c.req.param("id"));

  const attachment = Number.isInteger(attachmentId)
    ? await getAttachmentWithOwner(c.env.DB, attachmentId)
    : null;

  // A missing attachment and someone else's attachment answer identically, so a
  // client cannot probe for which ticket ids exist.
  if (
    attachment === null ||
    (user.is_admin !== 1 && attachment.owner_id !== user.id)
  ) {
    throw new HTTPException(404, { message: "Screenshot not found." });
  }

  const object = await c.env.SCREENSHOTS.get(attachment.r2_key);
  if (object === null) {
    throw new HTTPException(404, { message: "Screenshot not found." });
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": attachment.content_type,
      // cleanFilename leaves nothing that could break out of the quotes.
      "Content-Disposition": `inline; filename="${attachment.filename}"`,
      // The stored type was sniffed, not taken from the client; tell the browser
      // not to second-guess it, and forbid the response from pulling in
      // anything of its own.
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'",
      "Cache-Control": "private, max-age=300",
    },
  });
});

clientRoutes.post("/tickets", async (c) => {
  const user = currentUser(c);
  const settings = getSettings(c.env);

  const form = await c.req.formData();
  const siteIdRaw = String(form.get("site_id") ?? "");
  const kindRaw = String(form.get("kind") ?? "issue");
  const subject = String(form.get("subject") ?? "").trim();
  const body = String(form.get("body") ?? "").trim();

  const siteId = /^\d+$/.test(siteIdRaw) ? Number(siteIdRaw) : null;
  const site = siteId === null ? null : await getSite(c.env.DB, siteId);

  if (site === null) {
    return renderTickets(c, {
      error: "Choose which page this is about.",
      statusCode: 400,
    });
  }

  // The dropdown only offers pages this user holds, but the id arrives in the
  // request body, so the same rule is enforced here rather than trusted.
  if (!canAccess(user, site)) {
    return renderTickets(c, {
      error: "You do not have access to that page.",
      statusCode: 403,
    });
  }

  if (!subject) {
    return renderTickets(c, {
      error: "Add a short subject.",
      statusCode: 400,
    });
  }

  const kind = isTicketKind(kindRaw) ? kindRaw : "issue";

  let images: ValidatedImage[];
  try {
    images = await collectScreenshots(
      form.getAll("screenshots").filter((v): v is File => v instanceof File),
      {
        maxBytes: settings.maxAttachmentBytes,
        maxCount: settings.maxAttachmentsPerTicket,
      },
    );
  } catch (error) {
    if (!(error instanceof AttachmentError)) throw error;
    // A browser cannot repopulate a file input, so say so rather than let the
    // client wonder why the picker went blank.
    return renderTickets(c, {
      error: `${error.message} Please choose the screenshots again.`,
      statusCode: 400,
    });
  }

  // Bytes go to R2 first, under keys that carry no ticket id. A failure here
  // aborts before anything is written to D1, so a ticket is never rendered with
  // broken thumbnails; the reverse order could leave rows pointing at nothing.
  const stored = await Promise.all(
    images.map(async (image) => {
      const key = `screenshots/${crypto.randomUUID()}`;
      await c.env.SCREENSHOTS.put(key, image.bytes, {
        httpMetadata: { contentType: image.contentType },
      });
      return {
        filename: image.filename,
        contentType: image.contentType,
        sizeBytes: image.bytes.byteLength,
        r2Key: key,
      };
    }),
  );

  // submitted_at, user, and site are all captured here; they are the fields the
  // client sees on their ticket and the ones mirrored to Odoo.
  const ticketId = await createTicket(c.env.DB, {
    siteId: site.id,
    userId: user.id,
    subject: subject.slice(0, 200),
    body,
    kind,
  });
  await insertAttachments(c.env.DB, ticketId, stored);

  syncTicketBackground(c.env, c.executionCtx, ticketId);

  return c.redirect(`/tickets?submitted=${ticketId}`, 303);
});
