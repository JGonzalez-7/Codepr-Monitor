/**
 * Admin dashboard: fleet overview, ticket queue, page management, users.
 * Ported from app/routers/admin.py.
 */

import { Hono, type Context } from "hono";

import { getSettings } from "../config.ts";
import {
  countOpenTickets,
  createSite,
  createUser,
  getSite,
  getUserById,
  listAllTickets,
  listSites,
  listUsers,
  recentTickets,
  setUserSites,
  siteSlugExists,
  TICKET_LIST_LIMIT,
  updateSite,
  updateTicketStatus,
  updateUserProfile,
} from "../db.ts";
import { checkAllSites } from "../monitor.ts";
import { syncTicket } from "../odoo.ts";
import { hashPassword } from "../password.ts";
import { buildSiteCards, summarize } from "../presenters.ts";
import { currentUser, requireAdmin, setSession } from "../security.ts";
import { isTicketStatus, type AppEnv, type User } from "../types.ts";
import { AdminSitesPage } from "../views/admin/sites.tsx";
import { AdminTicketsPage } from "../views/admin/tickets.tsx";
import { AdminUsersPage } from "../views/admin/users.tsx";
import { DashboardPage } from "../views/admin/dashboard.tsx";
import { KumaPage } from "../views/admin/kuma.tsx";
import { landingFor } from "./auth.tsx";

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use("/admin", requireAdmin);
adminRoutes.use("/admin/*", requireAdmin);

const SLUG_RE = /[^a-z0-9]+/g;
const USERNAME_RE = /^[a-z0-9_.-]{3,64}$/;
const MIN_PASSWORD_LENGTH = 10;

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(SLUG_RE, "-").replace(/^-+|-+$/g, "") || "site";
}

/** An unchecked checkbox is simply absent from the body. */
function checked(value: unknown): boolean {
  return value === "true" || value === "on";
}

/** Checkbox groups arrive as one value, many values, or nothing at all. */
function numberList(form: FormData, field: string): number[] {
  return form
    .getAll(field)
    .map((value) => Number(String(value)))
    .filter((value) => Number.isInteger(value) && value > 0);
}

// --- Dashboard -----------------------------------------------------------

adminRoutes.get("/admin", async (c) => {
  const user = currentUser(c);
  const settings = getSettings(c.env);

  const [cards, openTickets, latest] = await Promise.all([
    buildSiteCards(c.env.DB, { includeInactive: true }),
    countOpenTickets(c.env.DB),
    recentTickets(c.env.DB, 8),
  ]);

  return c.html(
    <DashboardPage
      user={user}
      impersonator={c.get("impersonator")}
      cards={cards}
      summary={summarize(cards)}
      openTickets={openTickets}
      recentTickets={latest}
      checkInterval={settings.checkIntervalSeconds}
      cfTokenConfigured={settings.hasCfAccessToken}
      odooEnabled={settings.odooEnabled}
    />,
  );
});

adminRoutes.post("/admin/check-now", async (c) => {
  await checkAllSites(c.env);
  return c.redirect("/admin", 303);
});

// --- Tickets -------------------------------------------------------------

adminRoutes.get("/admin/tickets", async (c) => {
  const user = currentUser(c);
  const settings = getSettings(c.env);

  const statusParam = c.req.query("status") ?? "";
  const status = isTicketStatus(statusParam) ? statusParam : null;
  const tickets = await listAllTickets(c.env.DB, status);

  return c.html(
    <AdminTicketsPage
      user={user}
      impersonator={c.get("impersonator")}
      tickets={tickets}
      activeFilter={status ?? "all"}
      odooEnabled={settings.odooEnabled}
      truncated={tickets.length >= TICKET_LIST_LIMIT}
    />,
  );
});

adminRoutes.post("/admin/tickets/:id/status", async (c) => {
  const ticketId = Number(c.req.param("id"));
  const body = await c.req.parseBody();
  const status = String(body["status"] ?? "");

  if (Number.isInteger(ticketId) && isTicketStatus(status)) {
    await updateTicketStatus(c.env.DB, ticketId, status);
  }
  return c.redirect("/admin/tickets", 303);
});

/** Retry the Odoo mirror for a ticket whose first push failed. */
adminRoutes.post("/admin/tickets/:id/resync", async (c) => {
  const ticketId = Number(c.req.param("id"));
  if (Number.isInteger(ticketId)) await syncTicket(c.env, ticketId);
  return c.redirect("/admin/tickets", 303);
});

// --- Sites ---------------------------------------------------------------

adminRoutes.get("/admin/sites", async (c) => {
  const sites = await listSites(c.env.DB);
  return c.html(
    <AdminSitesPage
      user={currentUser(c)}
      impersonator={c.get("impersonator")}
      sites={sites}
    />,
  );
});

adminRoutes.post("/admin/sites", async (c) => {
  const form = await c.req.formData();
  const name = String(form.get("name") ?? "").trim();
  const url = String(form.get("url") ?? "").trim();

  let slug = slugify(name);
  if (await siteSlugExists(c.env.DB, slug)) {
    slug = `${slug}-${crypto.randomUUID().slice(0, 8)}`;
  }

  await createSite(c.env.DB, {
    slug,
    name: name.slice(0, 128),
    url: url.slice(0, 512),
    description: String(form.get("description") ?? "").trim().slice(0, 512),
    usesCfAccess: checked(form.get("uses_cf_access")),
  });

  return c.redirect("/admin/sites", 303);
});

adminRoutes.post("/admin/sites/:id", async (c) => {
  const siteId = Number(c.req.param("id"));
  const site = Number.isInteger(siteId) ? await getSite(c.env.DB, siteId) : null;

  if (site !== null) {
    const form = await c.req.formData();
    const newUrl = String(form.get("url") ?? "").trim().slice(0, 512);

    await updateSite(
      c.env.DB,
      site.id,
      {
        name: String(form.get("name") ?? "").trim().slice(0, 128),
        url: newUrl,
        description: String(form.get("description") ?? "").trim().slice(0, 512),
        isActive: checked(form.get("is_active")),
        usesCfAccess: checked(form.get("uses_cf_access")),
      },
      { clearHistory: newUrl !== site.url },
    );
  }

  return c.redirect("/admin/sites", 303);
});

// --- Users ---------------------------------------------------------------

/**
 * Accounts this session must not be able to strip admin from.
 *
 * Demoting yourself is how an installation ends up with no administrator at
 * all; demoting the admin behind an impersonation would invalidate the session
 * doing the demoting. Both are refused rather than explained afterwards.
 */
function protectedIds(admin: User, impersonator: User | null): number[] {
  return impersonator === null ? [admin.id] : [admin.id, impersonator.id];
}

async function renderUsers(
  c: Context<AppEnv>,
  options: {
    error?: string | null;
    notice?: string | null;
    statusCode?: 200 | 400 | 404;
  } = {},
) {
  const { error = null, notice = null, statusCode = 200 } = options;
  const admin = currentUser(c);
  const impersonator = c.get("impersonator");

  const [users, sites] = await Promise.all([
    listUsers(c.env.DB),
    listSites(c.env.DB),
  ]);

  return c.html(
    <AdminUsersPage
      user={admin}
      impersonator={impersonator}
      users={users}
      sites={sites}
      error={error}
      notice={notice}
      minPasswordLength={MIN_PASSWORD_LENGTH}
      protectedIds={protectedIds(admin, impersonator)}
    />,
    statusCode,
  );
}

/**
 * Validate the fields create and edit have in common.
 *
 * On edit a blank password means "leave it alone", so it is only measured when
 * it is required or when one was actually typed.
 */
async function accountError(
  db: D1Database,
  input: {
    username: string;
    fullName: string;
    password: string;
    passwordRequired: boolean;
    excludeId?: number | null;
  },
): Promise<string | null> {
  if (!USERNAME_RE.test(input.username)) {
    return (
      "Usernames are 3–64 characters, lowercase letters, digits, " +
      "dot, dash, or underscore."
    );
  }

  const clash = await db
    .prepare(`SELECT id FROM users WHERE username = ?`)
    .bind(input.username)
    .first<{ id: number }>();
  if (clash !== null && clash.id !== input.excludeId) {
    return `The username ${input.username} is taken.`;
  }

  if (!input.fullName) return "Add the person's full name.";

  if (
    (input.passwordRequired || input.password) &&
    input.password.length < MIN_PASSWORD_LENGTH
  ) {
    return `Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }

  return null;
}

adminRoutes.get("/admin/users", (c) => renderUsers(c));

/** Create an account, optionally as an admin, and grant it its pages. */
adminRoutes.post("/admin/users", async (c) => {
  const admin = currentUser(c);
  const settings = getSettings(c.env);

  const form = await c.req.formData();
  const username = String(form.get("username") ?? "").trim().toLowerCase();
  const fullName = String(form.get("full_name") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const isAdmin = checked(form.get("is_admin"));
  const siteIds = numberList(form, "site_ids");

  const error = await accountError(c.env.DB, {
    username,
    fullName,
    password,
    passwordRequired: true,
  });
  if (error) return renderUsers(c, { error, statusCode: 400 });

  // The password is hashed here and never stored or echoed back; the admin who
  // typed it is the one who passes it on.
  await createUser(c.env.DB, {
    username,
    fullName: fullName.slice(0, 128),
    email: String(form.get("email") ?? "").trim().slice(0, 255),
    passwordHash: await hashPassword(password, settings.pbkdf2Iterations),
    isAdmin,
    siteIds,
  });

  if (isAdmin) {
    console.log(`Admin ${admin.username} created administrator account ${username}`);
  }

  const role = isAdmin
    ? "administrator access"
    : `access to ${siteIds.length} page(s)`;
  return renderUsers(c, { notice: `Created ${username} with ${role}.` });
});

/** Replace the set of pages a user can see and raise tickets about. */
adminRoutes.post("/admin/users/:id/access", async (c) => {
  const userId = Number(c.req.param("id"));
  const account = Number.isInteger(userId)
    ? await getUserById(c.env.DB, userId)
    : null;

  if (account === null) {
    return renderUsers(c, {
      error: "That account no longer exists.",
      statusCode: 404,
    });
  }

  const form = await c.req.formData();
  await setUserSites(c.env.DB, account.id, numberList(form, "site_ids"));

  return renderUsers(c, {
    notice: `Updated the pages ${account.username} can see.`,
  });
});

/** Edit an account's details, its role, and optionally its password. */
adminRoutes.post("/admin/users/:id", async (c) => {
  const admin = currentUser(c);
  const impersonator = c.get("impersonator");
  const settings = getSettings(c.env);

  const userId = Number(c.req.param("id"));
  const account = Number.isInteger(userId)
    ? await getUserById(c.env.DB, userId)
    : null;

  if (account === null) {
    return renderUsers(c, {
      error: "That account no longer exists.",
      statusCode: 404,
    });
  }

  const form = await c.req.formData();
  const username = String(form.get("username") ?? "").trim().toLowerCase();
  const fullName = String(form.get("full_name") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const isAdmin = checked(form.get("is_admin"));

  const error = await accountError(c.env.DB, {
    username,
    fullName,
    password,
    passwordRequired: false,
    excludeId: account.id,
  });
  if (error) return renderUsers(c, { error, statusCode: 400 });

  if (!isAdmin && protectedIds(admin, impersonator).includes(account.id)) {
    return renderUsers(c, {
      error:
        "You cannot remove administrator access from the account you are " +
        "signed in with. Ask another administrator to do it.",
      statusCode: 400,
    });
  }

  const wasAdmin = account.is_admin === 1;
  const changedPassword = Boolean(password);

  await updateUserProfile(c.env.DB, account.id, {
    username,
    fullName: fullName.slice(0, 128),
    email: String(form.get("email") ?? "").trim().slice(0, 255),
    isAdmin,
    // Same rule as creation: hashed here, never stored or echoed back.
    ...(changedPassword
      ? { passwordHash: await hashPassword(password, settings.pbkdf2Iterations) }
      : {}),
  });

  if (wasAdmin !== isAdmin) {
    console.log(
      `Admin ${admin.username} ${isAdmin ? "granted" : "revoked"} ` +
        `administrator access for ${username}`,
    );
  }

  const suffix = changedPassword ? " Password reset." : "";
  return renderUsers(c, { notice: `Updated ${username}.${suffix}` });
});

/**
 * Swap the session over to another account, keeping the way back.
 *
 * The admin's own id rides along in the signed cookie, so the session is
 * genuinely the other user — every access check answers as it would for them —
 * and only /impersonate/stop restores it. Where an impersonation is already
 * running, the original admin stays the one to return to, so the chain cannot
 * be used to launder a session into a different admin.
 */
adminRoutes.post("/admin/users/:id/impersonate", async (c) => {
  const admin = currentUser(c);
  const impersonator = c.get("impersonator");

  const userId = Number(c.req.param("id"));
  const account = Number.isInteger(userId)
    ? await getUserById(c.env.DB, userId)
    : null;

  if (account === null) {
    return renderUsers(c, {
      error: "That account no longer exists.",
      statusCode: 404,
    });
  }

  const realAdmin = impersonator ?? admin;
  if (account.id === realAdmin.id) {
    return renderUsers(c, {
      error: "That is your own account — you are already signed in as it.",
      statusCode: 400,
    });
  }

  console.warn(`Admin ${realAdmin.username} started acting as ${account.username}`);

  await setSession(c, account, { impersonator: realAdmin });
  return c.redirect(landingFor(account), 303);
});

// --- Uptime Kuma ---------------------------------------------------------

adminRoutes.get("/admin/kuma", (c) =>
  c.html(
    <KumaPage
      user={currentUser(c)}
      impersonator={c.get("impersonator")}
      kumaUrl={getSettings(c.env).uptimeKumaEmbedUrl}
    />,
  ),
);
