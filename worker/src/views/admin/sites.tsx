/** Page management, ported from app/templates/admin/sites.html. */

import type { SiteRow, User } from "../../types.ts";
import { Layout } from "../layout.tsx";

export function AdminSitesPage({
  user,
  impersonator,
  sites,
}: {
  user: User;
  impersonator: User | null;
  sites: SiteRow[];
}) {
  return (
    <Layout
      title="Pages · CodePR-Monitor"
      user={user}
      impersonator={impersonator}
      path="/admin/sites"
    >
      <div class="page-head">
        <h1>Monitored pages</h1>
        <p>Add a page, correct a URL, or take one out of rotation.</p>
      </div>

      <div class="section" style="margin-top:0">
        <h2>Add a page</h2>
        <div class="form-card">
          <form method="post" action="/admin/sites">
            <div class="editor-grid">
              <div class="field">
                <label for="new-name">Display name</label>
                <input
                  type="text"
                  id="new-name"
                  name="name"
                  required
                  placeholder="Marketing site"
                />
              </div>
              <div class="field">
                <label for="new-url">URL</label>
                <input
                  type="url"
                  id="new-url"
                  name="url"
                  required
                  placeholder="https://example.com"
                />
              </div>
            </div>
            <div class="field">
              <label for="new-description">Description</label>
              <input
                type="text"
                id="new-description"
                name="description"
                placeholder="What clients should recognize this page as"
              />
            </div>
            <div class="check-row">
              <label>
                <input type="checkbox" name="uses_cf_access" value="true" /> Behind
                Cloudflare Access
              </label>
            </div>
            <button class="btn" type="submit">
              Add page
            </button>
          </form>
        </div>
      </div>

      <div class="section">
        <h2>Existing pages</h2>
        {sites.length > 0 ? (
          sites.map((site) => (
            <div class="site-editor">
              <form method="post" action={`/admin/sites/${site.id}`}>
                <div class="editor-grid">
                  <div class="field">
                    <label for={`name-${site.id}`}>Display name</label>
                    <input
                      type="text"
                      id={`name-${site.id}`}
                      name="name"
                      value={site.name}
                      required
                    />
                  </div>
                  <div class="field">
                    <label for={`url-${site.id}`}>URL</label>
                    <input
                      type="url"
                      id={`url-${site.id}`}
                      name="url"
                      value={site.url}
                      required
                    />
                  </div>
                </div>
                <div class="field">
                  <label for={`description-${site.id}`}>Description</label>
                  <input
                    type="text"
                    id={`description-${site.id}`}
                    name="description"
                    value={site.description}
                  />
                </div>
                <div class="check-row">
                  <label>
                    <input
                      type="checkbox"
                      name="is_active"
                      value="true"
                      checked={site.is_active === 1}
                    />{" "}
                    Actively monitored
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      name="uses_cf_access"
                      value="true"
                      checked={site.uses_cf_access === 1}
                    />{" "}
                    Behind Cloudflare Access
                  </label>
                </div>
                <button class="btn btn-ghost" type="submit">
                  Save changes
                </button>
              </form>
            </div>
          ))
        ) : (
          <div class="table-wrap">
            <p class="empty">No pages configured yet.</p>
          </div>
        )}
      </div>
    </Layout>
  );
}
