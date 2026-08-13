/** Page shell, ported from app/templates/base.html, login.html, error.html. */

import type { Child } from "hono/jsx";
import { raw } from "hono/html";

import type { User } from "../types.ts";

const FAVICON =
  "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>" +
  "<circle cx='50' cy='50' r='38' fill='%231a7f5a'/></svg>";

function Head({ title }: { title: string }) {
  return (
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <link rel="stylesheet" href="/static/app.css" />
      <link rel="icon" href={FAVICON} />
    </head>
  );
}

function active(condition: boolean): string {
  return condition ? "is-active" : "";
}

export interface LayoutProps {
  title: string;
  /** The effective user — the account being acted as, while impersonating. */
  user?: User | null;
  /** The admin behind an impersonated session, for the banner. */
  impersonator?: User | null;
  /** Request path, for marking the active nav item. */
  path: string;
  children?: Child;
  scripts?: Child;
}

export function Layout(props: LayoutProps) {
  const { title, user = null, impersonator = null, path } = props;

  return (
    <>
      {raw("<!doctype html>")}
      <html lang="en">
        <Head title={title} />
        <body>
          <header class="topbar">
            <a class="brand" href="/">
              <span class="brand-dot" aria-hidden="true"></span>
              CodePR-Monitor
            </a>

            {user && (
              <>
                <nav class="nav" aria-label="Main">
                  {user.is_admin === 1 ? (
                    <>
                      <a href="/admin" class={active(path === "/admin")}>
                        Dashboard
                      </a>
                      <a
                        href="/admin/tickets"
                        class={active(path.startsWith("/admin/tickets"))}
                      >
                        Tickets
                      </a>
                      <a
                        href="/admin/sites"
                        class={active(path.startsWith("/admin/sites"))}
                      >
                        Pages
                      </a>
                      <a
                        href="/admin/users"
                        class={active(path.startsWith("/admin/users"))}
                      >
                        Users
                      </a>
                      <a
                        href="/admin/kuma"
                        class={active(path.startsWith("/admin/kuma"))}
                      >
                        Uptime Kuma
                      </a>
                    </>
                  ) : (
                    <>
                      <a href="/status" class={active(path === "/status")}>
                        Page Status
                      </a>
                      <a href="/tickets" class={active(path.startsWith("/tickets"))}>
                        My Tickets
                      </a>
                    </>
                  )}
                </nav>

                <form class="session" method="post" action="/logout">
                  <span class="who">{user.full_name}</span>
                  <button class="btn btn-ghost" type="submit">
                    Sign out
                  </button>
                </form>
              </>
            )}
          </header>

          {impersonator && user && (
            <div class="impersonating" role="status">
              <span>
                You are acting as <strong>{user.full_name}</strong> ({user.username}
                ). Anything you do here is recorded as them.
              </span>
              <form method="post" action="/impersonate/stop">
                <button class="btn" type="submit">
                  Back to {impersonator.username}
                </button>
              </form>
            </div>
          )}

          <main class="page">{props.children}</main>

          <footer class="footer">CodePR-Monitor · times shown in UTC</footer>

          {props.scripts}
        </body>
      </html>
    </>
  );
}

export function LoginPage({ error }: { error: string | null }) {
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="en">
        <Head title="Sign in · CodePR-Monitor" />
        <body>
          <div class="login-shell">
            <div class="login-card">
              <h1>CodePR-Monitor</h1>
              <p class="sub">Sign in to see whether your pages are online.</p>

              {error && (
                <div class="alert error" role="alert">
                  {error}
                </div>
              )}

              <form method="post" action="/login">
                <div class="field">
                  <label for="username">Username</label>
                  <input
                    type="text"
                    id="username"
                    name="username"
                    autocomplete="username"
                    autocapitalize="none"
                    spellcheck={false}
                    required
                    autofocus
                  />
                </div>

                <div class="field">
                  <label for="password">Password</label>
                  <input
                    type="password"
                    id="password"
                    name="password"
                    autocomplete="current-password"
                    required
                  />
                </div>

                <button class="btn" type="submit">
                  Sign in
                </button>
              </form>
            </div>
          </div>
        </body>
      </html>
    </>
  );
}

export function ErrorPage({
  statusCode,
  detail,
  user,
  impersonator,
  path,
}: {
  statusCode: number;
  detail: string;
  user?: User | null;
  impersonator?: User | null;
  path: string;
}) {
  return (
    <Layout
      title={`${statusCode} · CodePR-Monitor`}
      user={user}
      impersonator={impersonator}
      path={path}
    >
      <div class="page-head">
        <h1>{statusCode}</h1>
        <p>{detail || "Something went wrong."}</p>
      </div>
      <a class="btn" href="/">
        Back to safety
      </a>
    </Layout>
  );
}
