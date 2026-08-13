/**
 * Which pages a given user is allowed to see and raise tickets about.
 *
 * Every client-facing read of the site list goes through here, so the rule
 * lives in one place: an admin is unrestricted, and a client sees exactly the
 * pages assigned to them under Users (/admin/users). A client with no
 * assignment sees nothing — that is the safe direction to fail, and the empty
 * state says so.
 */

import { listSites } from "./db.ts";
import type { SiteRow, User } from "./types.ts";

/** Site ids this user may see, or null meaning unrestricted. */
export function visibleSiteIds(user: User): number[] | null {
  return user.is_admin === 1 ? null : user.site_ids;
}

export function canAccess(user: User, site: SiteRow): boolean {
  return user.is_admin === 1 || user.site_ids.includes(site.id);
}

/** Pages this user may pick from, ordered by name. */
export async function accessibleSites(
  db: D1Database,
  user: User,
  options: { activeOnly?: boolean } = {},
): Promise<SiteRow[]> {
  const { activeOnly = true } = options;
  return listSites(db, { activeOnly, onlyIds: visibleSiteIds(user) });
}
