import { cn } from "@/lib/utils"
import type { CampaignStatus, Role } from "@/lib/types"

/**
 * A small filled dot. Colour carries the state, so the label beside it stays
 * plain text and the row keeps its typographic rhythm.
 */
function Dot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", className)}
    />
  )
}

const PILL =
  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap"

export function CampaignStatusBadge({
  status,
  className,
}: {
  status: CampaignStatus
  className?: string
}) {
  const isActive = status === "ACTIVE"
  return (
    <span
      className={cn(
        PILL,
        isActive
          ? "border-success/25 bg-success/10 text-success"
          : "border-border bg-muted/50 text-muted-foreground",
        className,
      )}
    >
      <Dot className={isActive ? "bg-success" : "bg-muted-foreground"} />
      {isActive ? "Active" : "Paused"}
    </span>
  )
}

export function RoleBadge({
  role,
  className,
}: {
  role: Role
  className?: string
}) {
  const isAdmin = role === "ADMIN"
  return (
    <span
      className={cn(
        PILL,
        isAdmin
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-border bg-muted/50 text-muted-foreground",
        className,
      )}
    >
      <Dot className={isAdmin ? "bg-primary" : "bg-muted-foreground"} />
      {isAdmin ? "Admin" : "Editor"}
    </span>
  )
}

/**
 * Vendor status. Unlike the badges above this is a toggle the admin controls
 * directly, and an inactive vendor stays in the list — so "Inactive" reads as
 * a state, not as a tombstone.
 */
export function ActiveBadge({
  active,
  className,
}: {
  active: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        PILL,
        active
          ? "border-success/25 bg-success/10 text-success"
          : "border-border bg-muted/50 text-muted-foreground",
        className,
      )}
    >
      <Dot className={active ? "bg-success" : "bg-muted-foreground"} />
      {active ? "Active" : "Inactive"}
    </span>
  )
}
