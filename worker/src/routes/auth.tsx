/** Login, logout, and ending an impersonated session. Ported from routers/auth.py. */

import { Hono } from "hono";

import { getSettings } from "../config.ts";
import { getUserByUsername } from "../db.ts";
import { verifyPassword } from "../password.ts";
import {
  clearSession,
  requireImpersonation,
  setSession,
} from "../security.ts";
import type { AppEnv, SqlBool } from "../types.ts";
import { LoginPage } from "../views/layout.tsx";

export const authRoutes = new Hono<AppEnv>();

export function landingFor(user: { is_admin: SqlBool }): string {
  return user.is_admin === 1 ? "/admin" : "/status";
}

authRoutes.get("/", (c) => {
  const user = c.get("user");
  return c.redirect(user === null ? "/login" : landingFor(user), 303);
});

authRoutes.get("/login", (c) => {
  const user = c.get("user");
  if (user !== null) return c.redirect(landingFor(user), 303);
  return c.html(<LoginPage error={null} />);
});

authRoutes.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const username = String(body["username"] ?? "").trim().toLowerCase();
  const password = String(body["password"] ?? "");

  const user = await getUserByUsername(c.env.DB, username);

  // Same message either way so the form does not reveal which usernames exist.
  // Verification still runs against a dummy hash for an unknown user, so the
  // response time does not either.
  const stored =
    user?.password_hash ??
    `pbkdf2_sha256$${getSettings(c.env).pbkdf2Iterations}$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;
  const ok = await verifyPassword(password, stored);

  if (!user || !ok) {
    return c.html(<LoginPage error="Incorrect username or password." />, 401);
  }

  await setSession(c, user);
  return c.redirect(landingFor(user), 303);
});

authRoutes.post("/logout", (c) => {
  clearSession(c);
  return c.redirect("/login", 303);
});

/**
 * Hand the session back to the admin who started the impersonation.
 *
 * This lives here rather than under /admin because the session doing the asking
 * is not an admin one — that is the whole point of it.
 */
authRoutes.post("/impersonate/stop", requireImpersonation, async (c) => {
  const admin = c.get("impersonator")!;
  console.log(`Impersonation ended, session returned to ${admin.username}`);
  await setSession(c, admin);
  return c.redirect(landingFor(admin), 303);
});
