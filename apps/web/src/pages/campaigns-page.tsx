import { useAuth } from "@/auth/auth-context"
import { CampaignsAdminView } from "@/pages/campaigns/campaigns-admin-view"
import { CampaignsBrowseView } from "@/pages/campaigns/campaigns-browse-view"

/**
 * `/campaigns` serves two audiences from one route.
 *
 * Admins get {@link CampaignsAdminView} — the dense table, with create, edit,
 * delete and the row detail sheet. Editors get {@link CampaignsBrowseView} — a
 * card grid of the campaigns they can pick up, each linking to the read-only
 * detail page at `/campaigns/:id`.
 *
 * This switch is **presentation only, not access control**. The API scopes
 * editors to ACTIVE campaigns server-side and rejects the write endpoints for
 * them, so an editor who forced the admin view would still see nothing extra
 * and could still change nothing. Route access is `ProtectedRoute`'s job, which
 * also guarantees a signed-in user by the time this renders.
 */
export function CampaignsPage() {
  const { user } = useAuth()

  return user?.role === "ADMIN" ? <CampaignsAdminView /> : <CampaignsBrowseView />
}
