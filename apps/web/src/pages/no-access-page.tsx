import { InboxIcon, LogOutIcon } from "lucide-react"
import { useNavigate } from "react-router-dom"

import { useAuth } from "@/auth/auth-context"
import { EmptyState } from "@/components/empty-state"
import { RoleBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"

/**
 * Editors have no features in this build: admins manage users and campaigns,
 * and everything an editor will eventually see is still to come.
 */
export function NoAccessPage() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  function signOut() {
    logout()
    void navigate("/login", { replace: true })
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="panel-sheen w-full max-w-md gap-0 overflow-hidden p-0 shadow-none">
        <EmptyState
          icon={InboxIcon}
          title="Nothing assigned yet"
          description="Your account is active, but no work has been routed to it. An admin will let you know when there is something here for you."
          action={
            <Button variant="outline" size="sm" onClick={signOut}>
              <LogOutIcon />
              Log out
            </Button>
          }
        />

        {user && (
          <div className="flex items-center justify-between gap-3 border-t bg-muted/30 px-4 py-2.5 text-[12px]">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-muted-foreground">
                Signed in as
              </span>
              <span className="truncate font-medium">{user.name}</span>
              <span className="numeric shrink-0 text-muted-foreground">
                {user.mobile}
              </span>
            </div>
            <RoleBadge role={user.role} />
          </div>
        )}
      </Card>
    </div>
  )
}
