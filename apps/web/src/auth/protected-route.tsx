import { Navigate, Outlet } from "react-router-dom"

import { useAuth } from "@/auth/auth-context"
import { Skeleton } from "@/components/ui/skeleton"

/** Placeholder shown while the stored token is exchanged for a session. */
function RouteSkeleton() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-6 py-10">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-80" />
      <div className="space-y-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    </div>
  )
}

/** Requires a signed-in user; sends everyone else to the login page. */
export function ProtectedRoute() {
  const { user, isLoading } = useAuth()

  if (isLoading) return <RouteSkeleton />
  if (!user) return <Navigate to="/login" replace />

  return <Outlet />
}

/** Requires an ADMIN; editors land on the no-access state instead. */
export function AdminRoute() {
  const { user, isLoading } = useAuth()

  if (isLoading) return <RouteSkeleton />
  if (!user) return <Navigate to="/login" replace />
  if (user.role !== "ADMIN") return <Navigate to="/no-access" replace />

  return <Outlet />
}
