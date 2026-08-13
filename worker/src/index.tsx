/**
 * CodePR-Monitor on Cloudflare Workers.
 *
 * `fetch` serves the app; `scheduled` replaces the background monitor thread
 * the Python version ran (app/main.py started it in the lifespan hook).
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { runMonitorRound } from "./monitor.ts";
import { adminRoutes } from "./routes/admin.tsx";
import { apiRoutes } from "./routes/api.ts";
import { authRoutes } from "./routes/auth.tsx";
import { clientRoutes } from "./routes/client.tsx";
import { loadSession } from "./security.ts";
import type { AppEnv, Env } from "./types.ts";
import { ErrorPage } from "./views/layout.tsx";

const app = new Hono<AppEnv>();

// Resolves the signed session cookie once, before any route runs.
app.use("*", loadSession);

app.route("/", authRoutes);
app.route("/", clientRoutes);
app.route("/", adminRoutes);
app.route("/", apiRoutes);

/** The Location an auth failure wants the browser sent to, if any. */
function redirectTarget(error: HTTPException): string | null {
  const cause = error.cause;
  if (cause && typeof cause === "object" && "location" in cause) {
    const location = (cause as { location: unknown }).location;
    if (typeof location === "string") return location;
  }
  return null;
}

/** Send browsers to the login page, but keep /api responses as JSON. */
app.onError((error, c) => {
  const isApi = c.req.path.startsWith("/api");

  if (!(error instanceof HTTPException)) {
    console.error("Unhandled error", error);
    if (isApi) return c.json({ detail: "Internal server error." }, 500);
    return c.html(
      <ErrorPage
        statusCode={500}
        detail="Something went wrong."
        user={c.get("user")}
        impersonator={c.get("impersonator")}
        path={c.req.path}
      />,
      500,
    );
  }

  const location = redirectTarget(error);

  if (location && !isApi) return c.redirect(location, 303);

  if (isApi) {
    // An auth redirect is not meaningful to a fetch() caller.
    return c.json({ detail: error.message }, location ? 401 : error.status);
  }

  return c.html(
    <ErrorPage
      statusCode={error.status}
      detail={error.message}
      user={c.get("user")}
      impersonator={c.get("impersonator")}
      path={c.req.path}
    />,
    error.status,
  );
});

app.notFound((c) => {
  if (c.req.path.startsWith("/api")) {
    return c.json({ detail: "Not found." }, 404);
  }
  return c.html(
    <ErrorPage
      statusCode={404}
      detail="That page does not exist."
      user={c.get("user")}
      impersonator={c.get("impersonator")}
      path={c.req.path}
    />,
    404,
  );
});

export default {
  fetch: app.fetch,

  /**
   * One round of probes per trigger.
   *
   * Errors are caught rather than rethrown for the same reason the Python loop
   * swallowed them: a failed round must never stop the next one.
   */
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      runMonitorRound(env).catch((error: unknown) => {
        console.error("Monitor round failed", error);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
