/** Account management, ported from app/templates/admin/users.html. */

import type { SiteRow, User } from "../../types.ts";
import { Layout } from "../layout.tsx";

export function AdminUsersPage({
  user,
  impersonator,
  users,
  sites,
  error,
  notice,
  minPasswordLength,
  protectedIds,
}: {
  user: User;
  impersonator: User | null;
  users: User[];
  sites: SiteRow[];
  error: string | null;
  notice: string | null;
  minPasswordLength: number;
  protectedIds: number[];
}) {
  return (
    <Layout
      title="Users · CodePR-Monitor"
      user={user}
      impersonator={impersonator}
      path="/admin/users"
    >
      <div class="page-head">
        <h1>Users</h1>
        <p>
          Create an account, edit its details, choose which pages it can see, and
          sign in as it to check what it sees.
        </p>
      </div>

      {notice && (
        <div class="alert success" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div class="alert error" role="alert">
          {error}
        </div>
      )}

      <div class="section" style="margin-top:0">
        <h2>Add a user</h2>
        <div class="form-card">
          <form method="post" action="/admin/users">
            <div class="editor-grid">
              <div class="field">
                <label for="new-username">Username</label>
                <input
                  type="text"
                  id="new-username"
                  name="username"
                  required
                  placeholder="client4"
                  autocomplete="off"
                />
              </div>
              <div class="field">
                <label for="new-full-name">Full name</label>
                <input
                  type="text"
                  id="new-full-name"
                  name="full_name"
                  required
                  placeholder="Client User Four"
                />
              </div>
            </div>

            <div class="editor-grid">
              <div class="field">
                <label for="new-email">Email</label>
                <input
                  type="text"
                  id="new-email"
                  name="email"
                  placeholder="person@example.com"
                />
              </div>
              <div class="field">
                <label for="new-password">Password</label>
                <input
                  type="password"
                  id="new-password"
                  name="password"
                  required
                  minlength={minPasswordLength}
                  autocomplete="new-password"
                />
                <p class="hint">
                  At least {minPasswordLength} characters. It is hashed on save and
                  never shown again, so pass it on before you leave this page.
                </p>
              </div>
            </div>

            <div class="field">
              <label>Pages this user can see</label>
              <div class="check-row">
                {sites.length > 0 ? (
                  sites.map((site) => (
                    <label>
                      <input
                        type="checkbox"
                        name="site_ids"
                        value={String(site.id)}
                      />{" "}
                      {site.name}
                    </label>
                  ))
                ) : (
                  <span class="muted">No pages configured yet.</span>
                )}
              </div>
            </div>

            <div class="check-row">
              <label>
                <input type="checkbox" name="is_admin" value="true" /> Administrator
              </label>
            </div>
            <p class="hint">
              An administrator sees every page, the ticket queue, and this screen,
              and can sign in as any other user. Page assignments above are ignored
              for them.
            </p>

            <button class="btn" type="submit">
              Create user
            </button>
          </form>
        </div>
      </div>

      <div class="section">
        <h2>Existing users</h2>
        {users.length > 0 ? (
          users.map((account) => {
            const isMe = protectedIds.includes(account.id);
            return (
              <div class="site-editor">
                <div class="user-head">
                  <div>
                    <strong>{account.full_name}</strong>
                    <div class="muted">
                      {account.username}
                      {account.email ? ` · ${account.email}` : ""}
                    </div>
                  </div>
                  <div class="user-actions">
                    {account.is_admin === 1 && (
                      <span class="tag resolved">Administrator</span>
                    )}
                    {isMe ? (
                      <span class="tag fix">You</span>
                    ) : (
                      <form
                        method="post"
                        action={`/admin/users/${account.id}/impersonate`}
                      >
                        <button class="btn btn-ghost" type="submit">
                          Sign in as {account.username}
                        </button>
                      </form>
                    )}
                  </div>
                </div>

                <form method="post" action={`/admin/users/${account.id}`}>
                  <div class="editor-grid">
                    <div class="field">
                      <label for={`username-${account.id}`}>Username</label>
                      <input
                        type="text"
                        id={`username-${account.id}`}
                        name="username"
                        required
                        value={account.username}
                        autocomplete="off"
                      />
                    </div>
                    <div class="field">
                      <label for={`full-name-${account.id}`}>Full name</label>
                      <input
                        type="text"
                        id={`full-name-${account.id}`}
                        name="full_name"
                        required
                        value={account.full_name}
                      />
                    </div>
                  </div>

                  <div class="editor-grid">
                    <div class="field">
                      <label for={`email-${account.id}`}>Email</label>
                      <input
                        type="text"
                        id={`email-${account.id}`}
                        name="email"
                        value={account.email}
                        placeholder="person@example.com"
                      />
                    </div>
                    <div class="field">
                      <label for={`password-${account.id}`}>New password</label>
                      <input
                        type="password"
                        id={`password-${account.id}`}
                        name="password"
                        minlength={minPasswordLength}
                        autocomplete="new-password"
                      />
                      <p class="hint">Leave blank to keep the current password.</p>
                    </div>
                  </div>

                  <div class="check-row">
                    {isMe ? (
                      <>
                        {/* Submitted for this row so an admin can still edit their
                            own name and email; the server refuses to strip its own
                            session's admin access. */}
                        <input type="hidden" name="is_admin" value="true" />
                        <span class="muted">
                          Administrator — you cannot remove this from your own
                          account.
                        </span>
                      </>
                    ) : (
                      <label>
                        <input
                          type="checkbox"
                          name="is_admin"
                          value="true"
                          checked={account.is_admin === 1}
                        />{" "}
                        Administrator
                      </label>
                    )}
                  </div>

                  <button class="btn" type="submit">
                    Save details
                  </button>
                </form>

                <form method="post" action={`/admin/users/${account.id}/access`}>
                  {account.is_admin === 1 ? (
                    <p class="hint">
                      Administrators see every page, so there is nothing to assign.
                    </p>
                  ) : (
                    <>
                      <div class="field">
                        <label>Pages this user can see</label>
                        <div class="check-row">
                          {sites.length > 0 ? (
                            sites.map((site) => (
                              <label>
                                <input
                                  type="checkbox"
                                  name="site_ids"
                                  value={String(site.id)}
                                  checked={account.site_ids.includes(site.id)}
                                />{" "}
                                {site.name}
                              </label>
                            ))
                          ) : (
                            <span class="muted">No pages configured yet.</span>
                          )}
                        </div>
                        {account.site_ids.length === 0 && (
                          <p class="hint">
                            No pages assigned — this user currently sees nothing.
                          </p>
                        )}
                      </div>
                      <button class="btn btn-ghost" type="submit">
                        Save access
                      </button>
                    </>
                  )}
                </form>
              </div>
            );
          })
        ) : (
          <div class="table-wrap">
            <p class="empty">No accounts yet.</p>
          </div>
        )}
      </div>
    </Layout>
  );
}
