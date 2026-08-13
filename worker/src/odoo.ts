/**
 * Mirror submitted tickets into Odoo, ported from app/odoo.py.
 *
 * Odoo is a downstream sink: the monitor owns the ticket, Odoo receives a copy
 * in the `codepr.monitor.ticket` model provided by the bundled addon (see
 * odoo-addon/codepr_monitor).
 *
 * JSON-RPC is used because odoo.code.pr sits behind Cloudflare Access, and this
 * lets the service-token headers ride along on every request.
 *
 * The Python version pushed on a background thread so a slow Odoo never delayed
 * a client's submission. Here that is `ctx.waitUntil`, which keeps the Worker
 * alive for the push after the response has already gone back.
 */

import { getSettings, type Settings } from "./config.ts";
import { getTicketForSync, recordOdooFailure, recordOdooSuccess } from "./db.ts";
import type { Env } from "./types.ts";

const ODOO_MODEL = "codepr.monitor.ticket";

export class OdooError extends Error {}

function cfHeaders(settings: Settings): Record<string, string> {
  if (!settings.hasCfAccessToken) return {};
  return {
    "CF-Access-Client-Id": settings.cfAccessClientId,
    "CF-Access-Client-Secret": settings.cfAccessClientSecret,
  };
}

async function call(
  settings: Settings,
  service: string,
  method: string,
  args: unknown[],
): Promise<unknown> {
  const endpoint = `${settings.odooUrl.replace(/\/+$/, "")}/jsonrpc`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...cfHeaders(settings),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: { service, method, args },
      id: 1,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (new URL(response.url || endpoint).hostname.includes("cloudflareaccess.com")) {
    throw new OdooError(
      "Blocked by Cloudflare Access — configure a service token authorized " +
        "for odoo.code.pr, or add a bypass policy for /jsonrpc.",
    );
  }

  if (!response.ok) {
    throw new OdooError(`Odoo answered HTTP ${response.status}.`);
  }

  const data = (await response.json()) as {
    result?: unknown;
    error?: { message?: string; data?: { message?: string } };
  };

  if (data.error) {
    throw new OdooError(
      data.error.data?.message || data.error.message || "unknown Odoo error",
    );
  }
  return data.result;
}

async function authenticate(settings: Settings): Promise<number> {
  const uid = await call(settings, "common", "login", [
    settings.odooDb,
    settings.odooUsername,
    settings.odooPassword,
  ]);
  if (!uid || typeof uid !== "number") {
    throw new OdooError(
      "Odoo rejected the credentials (check ODOO_DB / user / password).",
    );
  }
  return uid;
}

/** Odoo wants naive UTC, 'YYYY-MM-DD HH:MM:SS'. */
function odooDatetime(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace("T", " ");
}

/** Push one ticket to Odoo and record the outcome on the local row. */
export async function syncTicket(env: Env, ticketId: number): Promise<void> {
  const settings = getSettings(env);
  if (!settings.odooEnabled) return;

  const ticket = await getTicketForSync(env.DB, ticketId);
  if (!ticket) {
    console.warn(`Ticket ${ticketId} vanished before Odoo sync`);
    return;
  }

  const values = {
    name: ticket.subject,
    description: ticket.body,
    site_name: ticket.site_name,
    site_url: ticket.site_url,
    submitted_by: ticket.user_full_name,
    submitted_at: odooDatetime(ticket.submitted_at),
    kind: ticket.kind,
    state: ticket.status,
    monitor_ref: String(ticket.id),
  };

  try {
    const uid = await authenticate(settings);

    const execute = (method: string, args: unknown[]) =>
      call(settings, "object", "execute_kw", [
        settings.odooDb,
        uid,
        settings.odooPassword,
        ODOO_MODEL,
        method,
        args,
      ]);

    // An earlier attempt may have created the record but lost the response, so
    // adopt an existing match rather than duplicating.
    const existing = (await execute("search", [
      [["monitor_ref", "=", values.monitor_ref]],
    ])) as number[] | null;

    const odooId =
      existing && existing.length > 0
        ? existing[0]!
        : ((await execute("create", [values])) as number);

    await recordOdooSuccess(env.DB, ticketId, Number(odooId));
    console.log(`Ticket ${ticketId} mirrored to Odoo as ${odooId}`);
  } catch (error) {
    // The local ticket is still valid; the mirror is best-effort and retryable
    // from the admin queue.
    const message = error instanceof Error ? error.message : String(error);
    await recordOdooFailure(env.DB, ticketId, message);
    console.warn(`Odoo sync failed for ticket ${ticketId}: ${message}`);
  }
}

/**
 * Fire-and-forget push so submitting a ticket never waits on Odoo.
 *
 * Errors are already swallowed and recorded inside syncTicket; the extra catch
 * is there so an unexpected throw cannot reject the waitUntil promise and show
 * up as a Worker exception on a request that actually succeeded.
 */
export function syncTicketBackground(
  env: Env,
  // Structural, not `ExecutionContext`: Hono ships its own declaration of that
  // type and it is not assignable to the workers-types one.
  ctx: { waitUntil: (promise: Promise<unknown>) => void },
  ticketId: number,
): void {
  if (!getSettings(env).odooEnabled) return;
  ctx.waitUntil(
    syncTicket(env, ticketId).catch((error: unknown) => {
      console.error(`Odoo background sync crashed for ticket ${ticketId}`, error);
    }),
  );
}
