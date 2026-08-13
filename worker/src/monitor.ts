/**
 * Uptime checker, ported from app/monitor.py.
 *
 * The Python app ran this on a daemon thread. Workers has no threads, so the
 * loop is gone and a Cron Trigger drives one round per minute — see the
 * `scheduled` handler in src/index.tsx.
 */

import { getSettings, type Settings } from "./config.ts";
import { insertChecks, listSites, pruneChecks, refreshSiteStats } from "./db.ts";
import type { CheckStatus, Env, SiteRow } from "./types.ts";

const USER_AGENT = "CodePR-Monitor/0.1 (+uptime checker)";

/**
 * Cloudflare Zero Trust bounces unauthenticated traffic to this host. Seeing it
 * means the probe never reached the origin, so the origin's health is unknown.
 */
const CF_ACCESS_LOGIN_HOST = "cloudflareaccess.com";

/**
 * Redirects followed before a chain is called unresolved.
 *
 * Every hop is a subrequest, and a Worker gets 50 of those per invocation on
 * the Free plan — shared across every site in the round.
 */
const MAX_REDIRECTS = 5;

export interface ProbeResult {
  status: CheckStatus;
  httpStatus: number | null;
  responseMs: number | null;
  detail: string;
}

function headersFor(site: SiteRow, settings: Settings): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (site.uses_cf_access === 1 && settings.hasCfAccessToken) {
    headers["CF-Access-Client-Id"] = settings.cfAccessClientId;
    headers["CF-Access-Client-Secret"] = settings.cfAccessClientSecret;
  }
  return headers;
}

function hitsAccessWall(response: Response, url: string): boolean {
  if (new URL(url).hostname.includes(CF_ACCESS_LOGIN_HOST)) return true;
  if ((response.headers.get("www-authenticate") ?? "").startsWith("Cloudflare-Access")) {
    return true;
  }
  const location = response.headers.get("location") ?? "";
  return location.includes(CF_ACCESS_LOGIN_HOST);
}

/** Perform one HTTP check and classify the outcome. */
export async function probe(
  site: SiteRow,
  settings: Settings,
): Promise<ProbeResult> {
  const headers = headersFor(site, settings);
  const started = Date.now();

  let url = site.url;
  let response: Response;
  let hops = 0;

  try {
    // Redirects are followed by hand so every hop can be inspected. An Access
    // login redirect has to be caught wherever in the chain it appears, not
    // only at the end.
    for (;;) {
      response = await fetch(url, {
        method: "GET",
        headers,
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(settings.requestTimeoutSeconds * 1000),
      });

      if (hitsAccessWall(response, url)) {
        const reason = settings.hasCfAccessToken
          ? "service token was rejected"
          : "no service token configured";
        return {
          status: "degraded",
          httpStatus: response.status,
          responseMs: Date.now() - started,
          detail: `Blocked by Cloudflare Access — ${reason}. Origin health unknown.`,
        };
      }

      const location = response.headers.get("location");
      const isRedirect = response.status >= 300 && response.status < 400;
      if (!isRedirect || !location || hops >= MAX_REDIRECTS) break;

      url = new URL(location, url).toString();
      hops += 1;
    }
  } catch (error) {
    const timedOut =
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError");

    return {
      status: "down",
      httpStatus: null,
      responseMs: null,
      detail: timedOut
        ? `No response within ${settings.requestTimeoutSeconds}s.`
        : `Could not connect: ${error instanceof Error ? error.name : "Error"}.`,
    };
  }

  const elapsedMs = Date.now() - started;
  const code = response.status;

  if (code >= 200 && code < 300) {
    return { status: "up", httpStatus: code, responseMs: elapsedMs, detail: `HTTP ${code}` };
  }
  if (code >= 300 && code < 400) {
    return {
      status: "degraded",
      httpStatus: code,
      responseMs: elapsedMs,
      detail: `Unresolved redirect (HTTP ${code})`,
    };
  }
  return {
    status: "down",
    httpStatus: code,
    responseMs: elapsedMs,
    detail: `HTTP ${code}`,
  };
}

/**
 * Probe every active site once, record the results, and refresh the rollup.
 *
 * Probes run concurrently: the round has to finish inside one Worker
 * invocation, and a serial pass over N sites would cost N timeouts in the worst
 * case.
 */
export async function checkAllSites(env: Env): Promise<number> {
  const settings = getSettings(env);
  const sites = await listSites(env.DB, { activeOnly: true });
  if (sites.length === 0) return 0;

  const results = await Promise.all(
    sites.map(async (site) => ({ site, result: await probe(site, settings) })),
  );

  await insertChecks(
    env.DB,
    results.map(({ site, result }) => ({
      siteId: site.id,
      status: result.status,
      httpStatus: result.httpStatus,
      responseMs: result.responseMs,
      detail: result.detail,
    })),
  );

  await refreshSiteStats(env.DB);

  for (const { site, result } of results) {
    console.log(`check ${site.slug} -> ${result.status} (${result.detail})`);
  }
  return results.length;
}

/** One full round: probe, refresh the rollup, then drop expired history. */
export async function runMonitorRound(env: Env): Promise<void> {
  const settings = getSettings(env);
  const checked = await checkAllSites(env);
  await pruneChecks(env.DB, settings.historyRetentionDays);
  console.log(`Monitor round complete (${checked} site(s))`);
}
