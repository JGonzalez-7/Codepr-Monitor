/**
 * Signed session cookies and the auth middleware, ported from app/security.py.
 *
 * The session payload is signed with SECRET_KEY and carries its own issued-at
 * stamp. Cookie Max-Age is a hint the browser is free to ignore, so expiry is
 * re-checked here on every request against `iat` — that is what actually bounds
 * a session's life.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";

import { getSettings } from "./config.ts";
import { getUserById } from "./db.ts";
import type { AppEnv, User } from "./types.ts";

interface SessionPayload {
  /** The effective user: who the session acts as. */
  uid: number;
  /** The admin behind an impersonated session, if any. */
  imp?: number;
  /** Issued-at, epoch seconds. Checked server-side. */
  iat: number;
}

function assertSecret(secret: string | undefined): string {
  if (!secret) {
    // Failing loudly beats signing with a default: a predictable key means any
    // visitor can mint an admin session.
    throw new Error(
      "SECRET_KEY is not set. Run `wrangler secret put SECRET_KEY`, " +
        "or add it to .dev.vars for local runs.",
    );
  }
  return secret;
}

export async function setSession(
  c: Context<AppEnv>,
  user: { id: number },
  options: { impersonator?: { id: number } | null } = {},
): Promise<void> {
  const settings = getSettings(c.env);
  const payload: SessionPayload = {
    uid: user.id,
    iat: Math.floor(Date.now() / 1000),
  };

  // The impersonating admin is the only thing separating "signed in as this
  // person" from "acting as this person", so it rides inside the signed cookie
  // rather than anywhere the browser could edit.
  if (options.impersonator) payload.imp = options.impersonator.id;

  await setSignedCookie(
    c,
    settings.sessionCookieName,
    JSON.stringify(payload),
    assertSecret(c.env.SECRET_KEY),
    {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      // Workers only ever serves over HTTPS in production. Local `wrangler dev`
      // is http://localhost, which browsers exempt from the Secure rule.
      secure: true,
      maxAge: settings.sessionMaxAgeSeconds,
    },
  );
}

export function clearSession(c: Context<AppEnv>): void {
  const settings = getSettings(c.env);
  deleteCookie(c, settings.sessionCookieName, { path: "/" });
}

/**
 * Resolve the signed cookie to the effective user and stash both it and the
 * admin behind it on the context.
 *
 * "Effective" matters while an admin is impersonating: `user` is the person
 * being acted as, so every permission check in the app — including
 * requireAdmin — measures the impersonated account rather than the admin.
 */
export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("user", null);
  c.set("impersonator", null);

  const settings = getSettings(c.env);
  const secret = assertSecret(c.env.SECRET_KEY);

  let raw: string | false | undefined;
  try {
    raw = await getSignedCookie(c, secret, settings.sessionCookieName);
  } catch {
    // A malformed cookie is an absent session, not an error page.
    return next();
  }
  if (!raw) return next();

  let payload: SessionPayload;
  try {
    payload = JSON.parse(raw) as SessionPayload;
  } catch {
    return next();
  }

  if (typeof payload.uid !== "number" || typeof payload.iat !== "number") {
    return next();
  }

  const age = Math.floor(Date.now() / 1000) - payload.iat;
  if (age < 0 || age > settings.sessionMaxAgeSeconds) return next();

  const user = await getUserById(c.env.DB, payload.uid);
  if (!user) return next();

  if (payload.imp !== undefined) {
    // The cookie is signed, but the standing behind it can be revoked. An
    // impersonation is only valid while the admin who started it is still an
    // admin, so a demoted or deleted admin invalidates the whole session rather
    // than silently leaving it logged in as someone else.
    const impersonator =
      typeof payload.imp === "number"
        ? await getUserById(c.env.DB, payload.imp)
        : null;
    if (!impersonator || !impersonator.is_admin) return next();
    c.set("impersonator", impersonator);
  }

  c.set("user", user);
  return next();
};

/** Browsers follow the Location header; /api callers get this as a 401. */
function redirectToLogin(): HTTPException {
  return new HTTPException(303, {
    message: "Authentication required.",
    res: undefined,
    // Carried on the exception so the error handler can turn it into either a
    // redirect or a JSON 401, the way app/main.py did.
    cause: { location: "/login" },
  });
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("user") === null) throw redirectToLogin();
  return next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  if (user === null) throw redirectToLogin();
  if (!user.is_admin) {
    throw new HTTPException(403, {
      message: "This area is restricted to administrators.",
    });
  }
  return next();
};

/** The signed-in user on a route already behind requireUser/requireAdmin. */
export function currentUser(c: Context<AppEnv>): User {
  const user = c.get("user");
  if (!user) throw redirectToLogin();
  return user;
}

/**
 * The admin to hand the session back to when impersonation ends.
 *
 * Deliberately not behind requireAdmin: an admin acting as a client is not an
 * admin for the length of that session, so the way out cannot sit in the admin
 * area.
 */
export async function requireImpersonation(
  c: Context<AppEnv>,
  next: Next,
): Promise<void | Response> {
  if (c.get("impersonator") === null) {
    throw new HTTPException(400, {
      message: "No impersonation is in progress.",
    });
  }
  return next();
}
