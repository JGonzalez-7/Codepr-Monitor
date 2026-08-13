/** Uptime Kuma embed, ported from app/templates/admin/kuma.html. */

import type { User } from "../../types.ts";
import { Layout } from "../layout.tsx";

export function KumaPage({
  user,
  impersonator,
  kumaUrl,
}: {
  user: User;
  impersonator: User | null;
  kumaUrl: string;
}) {
  return (
    <Layout
      title="Uptime Kuma · CodePR-Monitor"
      user={user}
      impersonator={impersonator}
      path="/admin/kuma"
    >
      <div class="page-head">
        <h1>Uptime Kuma</h1>
        <p>Deeper history, alerting, and per-monitor detail.</p>
      </div>

      <div class="alert info">
        Kuma is a long-running container and cannot run on Workers, so it lives
        on its own host now. Point <code>UPTIME_KUMA_EMBED_URL</code> at it — a
        published status page (for example <code>{kumaUrl}/status/codepr</code>)
        embeds most reliably, since the full dashboard requires its own login
        inside the frame. If the frame stays blank, Kuma is refusing to be
        embedded.
        <div style="margin-top:.75rem">
          <a
            class="btn btn-ghost btn-small"
            href={kumaUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Uptime Kuma in a new tab
          </a>
        </div>
      </div>

      <iframe
        class="embed-frame"
        src={kumaUrl}
        title="Uptime Kuma dashboard"
        loading="lazy"
        referrerpolicy="no-referrer"
      ></iframe>
    </Layout>
  );
}
