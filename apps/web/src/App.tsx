import {
  createBrowserRouter,
  Link,
  Navigate,
  RouterProvider,
} from "react-router-dom"

import { AuthProvider } from "@/auth/auth-context"
import { AdminRoute, ProtectedRoute } from "@/auth/protected-route"
import { AppLayout } from "@/components/app-layout"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { CampaignDetailPage } from "@/pages/campaign-detail-page"
import { useAuth } from "@/auth/auth-context"
import { AdminDashboardPage } from "@/pages/admin-dashboard-page"
import { EditorDashboardPage } from "@/pages/editor-dashboard-page"
import { CampaignMatchesPage } from "@/pages/campaign-matches-page"
import { CampaignReelsPage } from "@/pages/campaign-reels-page"
import { CampaignFeedPage } from "@/pages/campaign-feed-page"
import { CampaignsPage } from "@/pages/campaigns-page"
import { LoginPage } from "@/pages/login-page"
import { NoAccessPage } from "@/pages/no-access-page"
import { UsersPage } from "@/pages/users-page"
import { VendorsPage } from "@/pages/vendors-page"

/**
 * One path, two dashboards.
 *
 * `/dashboard` stays a single address so every existing link and redirect
 * keeps working; which page it resolves to is a property of the caller.
 */
function DashboardRoute() {
  const { user } = useAuth()
  return user?.role === "ADMIN" ? <AdminDashboardPage /> : <EditorDashboardPage />
}

function NotFoundPage() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/30 px-6">
      <Card className="w-full max-w-sm text-center">
        <CardHeader>
          <CardTitle>Page not found</CardTitle>
          <CardDescription>
            That address does not match anything in this app.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link to="/">Go to the dashboard</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    // Everything below requires a session.
    element: <ProtectedRoute />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <Navigate to="/dashboard" replace /> },
          // Both roles, different pages. The editor one reads only the
          // caller's own submissions, so an admin — who has usually handed in
          // nothing — was greeted by an empty state on their landing page.
          { path: "dashboard", element: <DashboardRoute /> },
          { path: "no-access", element: <NoAccessPage /> },
          // Campaigns are open to every signed-in user: the page itself picks
          // the admin table or the editor browse grid, and the API scopes what
          // each role can see and change.
          { path: "campaigns", element: <CampaignsPage /> },
          { path: "campaigns/:id", element: <CampaignDetailPage /> },
          {
            element: <AdminRoute />,
            children: [
              // Admin-only: the feed shows every editor's cuts, which an
              // editor is never allowed to see.
              { path: "campaigns/:id/feed", element: <CampaignFeedPage /> },
              { path: "campaigns/:id/reels", element: <CampaignReelsPage /> },
              {
                path: "campaigns/:id/matches",
                element: <CampaignMatchesPage />,
              },
              { path: "vendors", element: <VendorsPage /> },
              { path: "users", element: <UsersPage /> },
            ],
          },
        ],
      },
    ],
  },
  { path: "*", element: <NotFoundPage /> },
])

export default function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  )
}
